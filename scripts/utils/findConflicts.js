/* eslint-disable no-continue */
/* eslint-disable no-console */
const Web3 = require('web3');
const fs = require('fs');
const path = require('path');
const os = require('os');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const yargs = require('yargs');
const BigNumber = require('bignumber.js');
const mongoose = require('mongoose');
require('mongoose-long')(mongoose);
require('../../src/models/mongoose-bn')(mongoose);
const { LiquidPledging, LiquidPledgingState } = require('giveth-liquidpledging');
const toFn = require('../../src/utils/to');
const DonationUsdValueUtility = require('./DonationUsdValueUtility');

const { argv } = yargs
  .option('dry-run', {
    describe: 'enable dry run',
    type: 'boolean',
    default: false,
  })
  .option('update-network-cache', {
    describe: 'update network state and events cache',
    type: 'boolean',
    default: false,
  })
  .option('config', {
    describe: 'basename of a json config file name. e.g. default, production, develop',
    type: 'string',
    demand: true,
  })
  .option('cache-dir', {
    describe: 'directory to create cache file inside',
    type: 'string',
    default: path.join(os.tmpdir(), 'simulation-script'),
  })
  .option('log-dir', {
    describe: 'directory to save logs inside, if empty logs will be write to stdout',
    type: 'string',
  })
  .option('debug', {
    describe: 'produce debugging log',
    type: 'boolean',
  })
  .demandOption(
    ['config'],
    'Please provide config file holds network gateway and DB connection URI',
  )
  .version(false)
  .help();

const configFileName = argv.config;
const cacheDir = argv['cache-dir'];
const logDir = argv['log-dir'];
const updateState = argv['update-network-cache'];
const updateEvents = argv['update-network-cache'];
const findConflicts = !argv['dry-run'];
const fixConflicts = !argv['dry-run'];

console.log(cacheDir);
const winstonTransports = [];
if (logDir) {
  winstonTransports.push(
    new DailyRotateFile({
      dirname: logDir,
      filename: 'simulation-error-%DATE%.log',
      maxFiles: '30d',
    }),
  );
} else {
  winstonTransports.push(new winston.transports.Console());
}

const logger = winston.createLogger({
  level: argv.debug ? 'debug' : 'error',
  format: winston.format.simple(),
  transports: winstonTransports,
});

const terminateScript = (message = '', code = 0) => {
  if (message) {
    logger.error(`Exit message: ${message}`);
  }

  logger.on('finish', () => {
    setTimeout(() => process.exit(code), 5 * 1000);
  });

  logger.end();
};

if (!argv.config) {
  terminateScript('config file name cannot be empty ');
}

// eslint-disable-next-line import/no-dynamic-require
const config = require(`../../config/${configFileName.toString()}.json`);

const { ignoredTransactions } = require('./eventProcessingHelper.json');

// Create output log file

// Map token symbol to foreign address
const tokenSymbolToForeignAddress = {};
config.tokenWhitelist.forEach(token => {
  tokenSymbolToForeignAddress[token.symbol] = token.foreignAddress.toLowerCase();
});

const symbolDecimalsMap = {};

config.tokenWhitelist.forEach(({ symbol, decimals }) => {
  symbolDecimalsMap[symbol] = {
    cutoff: new BigNumber(10 ** (18 - Number(decimals))),
  };
});

const { nodeUrl, liquidPledgingAddress } = config.blockchain;

const appFactory = () => {
  const data = {};
  return {
    get(key) {
      return data[key];
    },
    set(key, val) {
      data[key] = val;
    },
  };
};

const app = appFactory();
app.set('mongooseClient', mongoose);

const Milestones = require('../../src/models/milestones.model').createModel(app);
const Campaigns = require('../../src/models/campaigns.model').createModel(app);
const DACs = require('../../src/models/dacs.model').createModel(app);
const Donations = require('../../src/models/donations.model').createModel(app);
const PledgeAdmins = require('../../src/models/pledgeAdmins.model').createModel(app);
const ConversationRates = require('../../src/models/conversionRates.model')(app);

const { DonationStatus } = require('../../src/models/donations.model');
const { AdminTypes } = require('../../src/models/pledgeAdmins.model');
const { DacStatus } = require('../../src/models/dacs.model');
const { CampaignStatus } = require('../../src/models/campaigns.model');
const { MilestoneStatus } = require('../../src/models/milestones.model');

const donationUsdValueUtility = new DonationUsdValueUtility(ConversationRates);

// Instantiate Web3 module
// @params {string} url blockchain node url address
const instantiateWeb3 = url => {
  const provider =
    url && url.startsWith('ws')
      ? new Web3.providers.WebsocketProvider(url, {
          clientConfig: {
            maxReceivedFrameSize: 100000000,
            maxReceivedMessageSize: 100000000,
          },
        })
      : url;
  return new Web3(provider);
};

// Gets status of liquidpledging storage
const getBlockchainData = async () => {
  try {
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir);
    }
  } catch (e) {
    terminateScript(e.stack);
  }
  const stateFile = path.join(cacheDir, `./liquidPledgingState_${configFileName}.json`);
  const eventsFile = path.join(cacheDir, `./liquidPledgingEvents_${configFileName}.json`);

  let state = {};
  let events = [];

  if (!updateState) state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : {};
  events = fs.existsSync(eventsFile) ? JSON.parse(fs.readFileSync(eventsFile)) : [];

  if (updateState || updateEvents) {
    const foreignWeb3 = instantiateWeb3(nodeUrl);
    let fromBlock = 0;
    let fetchBlockNum = 'latest';
    if (updateEvents) {
      fromBlock = events.length > 0 ? events[events.length - 1].blockNumber + 1 : 0;
      fetchBlockNum =
        (await foreignWeb3.eth.getBlockNumber()) - config.blockchain.requiredConfirmations;
    }

    const liquidPledging = new LiquidPledging(foreignWeb3, liquidPledgingAddress);
    const liquidPledgingState = new LiquidPledgingState(liquidPledging);

    let newEvents = [];
    let error = null;
    let firstTry = true;
    while (
      error ||
      !Array.isArray(state.pledges) ||
      state.pledges.length <= 1 ||
      !Array.isArray(state.admins) ||
      state.admins.length <= 1 ||
      !Array.isArray(newEvents)
    ) {
      if (!firstTry) {
        logger.error('Some problem on fetching network info... Trying again!');
        if (!Array.isArray(state.pledges) || state.pledges.length <= 1) {
          logger.debug(`state.pledges: ${state.pledges}`);
        }
        if (!Array.isArray(state.admins) || state.admins.length <= 1) {
          logger.debug(`state.admins: ${state.admins}`);
        }
      }
      // eslint-disable-next-line no-await-in-loop
      [error, [state, newEvents]] = await toFn(
        Promise.all([
          updateState ? liquidPledgingState.getState() : Promise.resolve(state),
          updateEvents
            ? liquidPledging.$contract.getPastEvents('allEvents', {
                fromBlock,
                toBlock: fetchBlockNum,
              })
            : Promise.resolve([]),
        ]),
      );
      if (error && error instanceof Error) {
        logger.error(`Error on fetching network info\n${error.stack}`);
      }
      firstTry = false;
    }

    if (updateState) fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    if (updateEvents && newEvents) {
      events = [...events, ...newEvents];
      fs.writeFileSync(eventsFile, JSON.stringify(events, null, 2));
    }
  }
  return {
    state,
    events,
  };
};

// Update createdAt date of donations based on transaction date
// @params {string} startDate
// eslint-disable-next-line no-unused-vars
const updateDonationsCreatedDate = async startDate => {
  const foreignWeb3 = instantiateWeb3(nodeUrl);
  await Donations.find({
    createdAt: {
      $gte: startDate.toISOString(),
    },
  })
    .cursor()
    .eachAsync(async ({ _id, txHash, createdAt }) => {
      const { blockNumber } = await foreignWeb3.eth.getTransaction(txHash);
      const { timestamp } = await foreignWeb3.eth.getBlock(blockNumber);
      const newCreatedAt = new Date(timestamp * 1000);
      if (createdAt.toISOString() !== newCreatedAt.toISOString()) {
        logger.info(
          `Donation ${_id.toString()} createdAt is changed from ${createdAt.toISOString()} to ${newCreatedAt.toISOString()}`,
        );
        logger.info('Updating...');
        const [d] = await Donations.find({ _id }).exec();
        d.createdAt = newCreatedAt;
        await d.save();
      }
    });
};

// Returns a map contains empty donation items for each pledge
const getPledgeDonationItems = async () => {
  const pledgeDonationListMap = new Map();
  // Map from _id to donation
  const donationMap = new Map();
  // TODO: pendingAmountRemaining is not considered in updating, it should be removed for successful transactions
  await Donations.find({})
    .sort({ createdAt: 1 })
    .cursor()
    .eachAsync(
      ({
        _id,
        amount,
        amountRemaining,
        pledgeId,
        status,
        mined,
        txHash,
        parentDonations,
        ownerId,
        ownerType,
        intendedProjectId,
        giverAddress,
        token,
      }) => {
        // if (pledgeId === '0') return;

        let list = pledgeDonationListMap.get(pledgeId.toString());
        if (list === undefined) {
          list = [];
          pledgeDonationListMap.set(pledgeId.toString(), list);
        }

        const item = {
          _id: _id.toString(),
          amount: amount.toString(),
          savedAmountRemaining: amountRemaining.toString(),
          amountRemaining: new BigNumber(0),
          txHash,
          status,
          mined,
          parentDonations: parentDonations.map(id => id.toString()),
          ownerId,
          ownerType,
          intendedProjectId,
          giverAddress,
          pledgeId: pledgeId.toString(),
          token,
        };

        list.push(item);
        donationMap.set(_id.toString(), item);
      },
    );
  return { pledgeDonationListMap, donationMap };
};

const convertPledgeStateToStatus = (pledge, pledgeAdmin) => {
  const { pledgeState, delegates, intendedProject } = pledge;
  switch (pledgeState) {
    case 'Paying':
    case '1':
      return DonationStatus.PAYING;

    case 'Paid':
    case '2':
      return DonationStatus.PAID;

    case 'Pledged':
    case '0':
      if (intendedProject !== '0') return DonationStatus.TO_APPROVE;
      if (pledgeAdmin.type === 'Giver' || delegates.length > 0) return DonationStatus.WAITING;
      return DonationStatus.COMMITTED;

    default:
      return null;
  }
};

const handleFromDonations = async (
  from,
  to,
  amount,
  transactionHash,
  logIndex,
  pledges,
  admins,
  pledgeNotFilledDonations,
  chargedDonationList,
  donationMap,
) => {
  const usedFromDonations = []; // List of donations which could be parent of the donation
  let isIgnored = false;
  let giverAddress;

  let toUnusedDonationList = pledgeNotFilledDonations.get(to); // List of donations which are candidates to be charged
  if (toUnusedDonationList === undefined) {
    logger.debug(`There is no donation for pledgeId ${to}`);
    toUnusedDonationList = [];
    pledgeNotFilledDonations.set(to, toUnusedDonationList);
  }

  const toPledge = pledges[Number(to)];
  const toOwnerId = toPledge.owner;
  const fromOwnerId = from !== '0' ? pledges[Number(from)].owner : null;

  const toOwnerAdmin = admins[Number(toOwnerId)];
  const fromOwnerAdmin = from !== '0' ? admins[Number(fromOwnerId)] : {};

  if (from !== '0') {
    const candidateChargedParents = chargedDonationList.get(from) || [];

    // Trying to find the best parent from DB
    let candidateToDonationList = toUnusedDonationList.filter(
      item => item.txHash === transactionHash && item.amountRemaining.eq(0),
    );

    if (candidateToDonationList.length > 1) {
      logger.debug('candidateToDonationList length is greater than one!');
    } else if (candidateToDonationList.length === 0) {
      // Try to find donation among failed ones!
      const failedDonationList = pledgeNotFilledDonations.get('0') || [];
      const matchingFailedDonationIndex = failedDonationList.findIndex(item => {
        if (item.txHash === transactionHash && item.amount === amount) {
          const { parentDonations } = item;
          if (from === '0') {
            return parentDonations.length === 0;
          } // It should not have parent
          // Check whether parent pledgeId equals from
          if (parentDonations.length === 0) return false;
          const parent = donationMap.get(item.parentDonations[0]);
          return parent.pledgeId === from;
        }
        return false;
      });

      // A matching failed donation found, it's not failed and should be updated with correct value
      if (matchingFailedDonationIndex !== -1) {
        const toFixDonation = failedDonationList[matchingFailedDonationIndex];
        logger.error(`Donation ${toFixDonation._id} hasn't failed, it should be updated`);

        // Remove from failed donations
        failedDonationList.splice(matchingFailedDonationIndex, 1);

        toFixDonation.status = convertPledgeStateToStatus(toPledge, toOwnerAdmin);
        toFixDonation.pledgeId = to;
        toFixDonation.mined = true;
        toUnusedDonationList.push(toFixDonation);

        candidateToDonationList = [toFixDonation];

        logger.debug('Will update to:');
        logger.debug(JSON.stringify(toFixDonation, null, 2));

        if (fixConflicts) {
          logger.debug('Updating...');
          await Donations.update(
            { _id: toFixDonation._id },
            { status: toFixDonation.status, pledgeId: to },
          ).exec();
        }
      }
    }

    /* updateParents had been used while script was not trusted
     * true value for this variable allows script to update parents of each donation it wants
     */
    // const updateParents = corruptedParentPledgeIds.includes(from);
    const updateParents = true;

    const candidateParentsFromDB = [];
    if (!updateParents && candidateToDonationList.length > 0) {
      const { parentDonations } = candidateToDonationList[0];
      parentDonations.forEach(parent => candidateParentsFromDB.push(parent));
    }

    // *** Remove verifiedTransfers feature (Create any donation that is not ignored)
    // const transfer = verifiedTransfers.find(
    //   tt => tt.txHash === transactionHash && tt.logIndex === logIndex,
    // );
    // // Paid and Paying donations should be created (Not creating Paid donations is a common mistake!)
    // const isVerified =
    //   transfer !== undefined || ['Paid', 'Paying', 'Waiting'].includes(toPledge.pledgeState);

    const isVerified = true;

    // Reduce money from parents one by one
    if (candidateParentsFromDB.length > 0) {
      let fromAmount = new BigNumber(amount);
      candidateParentsFromDB.forEach(parentId => {
        if (fromAmount.eq(0)) {
          logger.debug(`No money is moved from parent ${parentId}`);
          return;
        }
        const index = candidateChargedParents.findIndex(item => item._id && item._id === parentId);
        if (index === -1) {
          // TODO: for canceled projects we should transfer money too.
          // if (toOwnerAdmin.isCanceled || toOwnerAdmin.canceled) {
          //   console.log('To owner is canceled, transfer is ignored');
          //   isIgnored = true;
          //   return;
          // }
          // if (fromOwnerAdmin.isCanceled || fromOwnerAdmin.canceled) {
          //   console.log('From owner is canceled, transfer is ignored');
          //   isIgnored = true;
          //   return;
          // }

          candidateChargedParents.forEach(p => {
            logger.debug(`Parent ${p._id} amount remaining ${p.amountRemaining.toFixed()}`);
          });

          terminateScript(
            `no appropriate parent(s) found to move ${candidateToDonationList[0]._id}`,
          );
        }
        const d = candidateChargedParents[index];
        if (d.giverAddress) giverAddress = d.giverAddress;

        const min = BigNumber.min(d.amountRemaining, fromAmount);
        fromAmount = fromAmount.minus(min);
        d.amountRemaining = d.amountRemaining.minus(min);

        logger.debug(
          `Amount ${min.toFixed()} is reduced from ${JSON.stringify(
            { ...d, amountRemaining: d.amountRemaining.toFixed() },
            null,
            2,
          )}`,
        );

        if (d._id) {
          usedFromDonations.push(d._id);
        }

        // Remove donation from candidate if it's drained
        if (d.amountRemaining.eq(0)) {
          candidateChargedParents.splice(index, 1);
        }

        // if (d.status === DonationStatus.CANCELED) {
        //   parentIsCancelled = true;
        // }
      });
      if (!fromAmount.eq(0) && !isIgnored) {
        terminateScript('All money is not moved');
      }
    } else if (!isVerified && (toOwnerAdmin.isCanceled || toOwnerAdmin.canceled)) {
      logger.debug('To owner is canceled, transfer is ignored');
      isIgnored = true;
    } else if (!isVerified && (fromOwnerAdmin.isCanceled || fromOwnerAdmin.canceled)) {
      logger.debug('From owner is canceled, transfer is ignored');
      isIgnored = true;
    } else if (candidateChargedParents.length > 0) {
      let fromAmount = new BigNumber(amount);
      let consumedCandidates = 0;
      for (let j = 0; j < candidateChargedParents.length; j += 1) {
        const item = candidateChargedParents[j];

        if (item.giverAddress) {
          giverAddress = item.giverAddress;
        }
        // if (item.status === DonationStatus.CANCELED) {
        //   parentIsCancelled = true;
        // }

        const min = BigNumber.min(item.amountRemaining, fromAmount);
        item.amountRemaining = item.amountRemaining.minus(min);
        if (item.amountRemaining.eq(0)) {
          consumedCandidates += 1;
        }
        fromAmount = fromAmount.minus(min);
        logger.debug(
          `Amount ${min.toFixed()} is reduced from ${JSON.stringify(
            { ...item, amountRemaining: item.amountRemaining.toFixed() },
            null,
            2,
          )}`,
        );
        if (item._id) {
          usedFromDonations.push(item._id);
        }
        if (fromAmount.eq(0)) break;
      }

      chargedDonationList.set(from, candidateChargedParents.slice(consumedCandidates));

      if (!fromAmount.eq(0)) {
        logger.debug(`from delegate ${from} donations don't have enough amountRemaining!`);
        logger.debug(`Deficit amount: ${fromAmount.toFixed()}`);
        logger.debug('Not used candidates:');
        candidateChargedParents.forEach(candidate =>
          logger.debug(JSON.stringify(candidate, null, 2)),
        );
        terminateScript();
      }
    } else {
      terminateScript(`There is no donation for transfer from ${from} to ${to}`);
    }
  }

  return { usedFromDonations, isIgnored, giverAddress };
};

const handleToDonations = async (
  from,
  to,
  amount,
  foreignWeb3,
  transactionHash,
  blockNumber,
  logIndex,
  pledges,
  admins,
  pledgeNotFilledDonations,
  candidateDonationList,
  chargedDonationList,
  usedFromDonations,
  isIgnored,
  giverAddress,
  donationMap,
) => {
  if (isIgnored) return;

  let toNotFilledDonationList = pledgeNotFilledDonations.get(to); // List of donations which are candidates to be charged
  if (toNotFilledDonationList === undefined) {
    logger.debug(`There is no donation for pledgeId ${to}`);
    toNotFilledDonationList = [];
    pledgeNotFilledDonations.set(to, toNotFilledDonationList);
  }

  // const updateParents = corruptedParentPledgeIds.includes(from);
  const updateParents = true;
  const toIndex = toNotFilledDonationList.findIndex(
    item =>
      item.txHash === transactionHash &&
      item.amountRemaining.eq(0) &&
      (updateParents ||
        (item.parentDonations.length === usedFromDonations.length &&
          item.parentDonations.every(parent =>
            usedFromDonations.some(value => value.toString() === parent),
          ))),
  );

  const toDonation = toIndex !== -1 ? toNotFilledDonationList.splice(toIndex, 1)[0] : undefined;

  // It happens when a donation is cancelled, we choose the first one (created earlier)
  // if (toDonationList.length > 1) {
  //   console.log('toDonationList length is greater than 1');
  //   process.exit();
  // }

  const fromPledge = pledges[Number(from)];
  const toPledge = pledges[Number(to)];

  const toOwnerId = toPledge.owner;
  const fromOwnerId = from !== '0' ? fromPledge.owner : 0;

  const toOwnerAdmin = admins[Number(toOwnerId)];
  const fromOwnerAdmin = from !== '0' ? admins[Number(fromOwnerId)] : {};

  if (toDonation === undefined) {
    // If parent is cancelled, this donation is not needed anymore
    if (!isIgnored) {
      const status = convertPledgeStateToStatus(toPledge, toOwnerAdmin);

      const expectedToDonation = {
        txHash: transactionHash,
        parentDonations: usedFromDonations,
        from,
        pledgeId: to,
        pledgeState: toPledge.pledgeState,
        amount,
        amountRemaining: new BigNumber(amount),
        ownerId: toOwnerId,
        status,
        giverAddress,
      };

      // *** Remove verifiedTransfers feature (Create any donation that is not ignored)
      // // If it is a verified transaction that should be added to database
      // let transfer = veriVjfiedTransfers.find(
      //   tt => tt.txHash === transactionHash && tt.logIndex === logIndex,
      // );
      //
      // // Paid donations should be created (Not creating Paid donations is a common mistake!)
      // const isVerified =
      //   transfer !== undefined || ['Paid', 'Paying', 'Waiting'].includes(toPledge.pledgeState);
      // if (transfer === undefined) {
      //   transfer = {};
      // }

      const isVerified = true;
      const transfer = {};

      if (isVerified && fixConflicts) {
        let [toPledgeAdmin] = await PledgeAdmins.find({ id: Number(toOwnerId) }).exec();
        if (toPledgeAdmin === undefined) {
          if (toOwnerAdmin.type !== 'Giver') {
            terminateScript(
              `No PledgeAdmin record exists for non user admin ${JSON.stringify(
                toOwnerAdmin,
                null,
                2,
              )}`,
            );
            return;
          }

          // Create user pledge admin
          toPledgeAdmin = new PledgeAdmins({
            id: Number(toOwnerId),
            type: AdminTypes.GIVER,
            typeId: toOwnerAdmin.addr,
          });
          await toPledgeAdmin.save();
          logger.info(`pledgeAdmin crated: ${toPledgeAdmin._id.toString()}`);
        }

        // Create donation
        const token = config.tokenWhitelist.find(
          t => t.foreignAddress.toLowerCase() === toPledge.token.toLowerCase(),
        );
        if (token === undefined) {
          terminateScript(`No token found for address ${toPledge.token}`);
          return;
        }
        expectedToDonation.token = token;

        const delegationInfo = {};
        // It's delegated to a DAC
        if (toPledge.delegates.length > 0) {
          const [delegate] = toPledge.delegates;
          const [dacPledgeAdmin] = await PledgeAdmins.find({ id: Number(delegate.id) }).exec();
          if (dacPledgeAdmin === undefined) {
            terminateScript(`No dac found for id: ${delegate.id}`);
            return;
          }
          delegationInfo.delegateId = dacPledgeAdmin.id;
          delegationInfo.delegateTypeId = dacPledgeAdmin.typeId;
          delegationInfo.delegateType = dacPledgeAdmin.type;

          // Has intended project
          const { intendedProject } = toPledge;
          if (intendedProject !== '0') {
            const [intendedProjectPledgeAdmin] = await PledgeAdmins.find({
              id: Number(intendedProject),
            });
            if (intendedProjectPledgeAdmin === undefined) {
              terminateScript(`No project found for id: ${intendedProject}`);
              return;
            }
            delegationInfo.intendedProjectId = intendedProjectPledgeAdmin.id;
            delegationInfo.intendedProjectTypeId = intendedProjectPledgeAdmin.typeId;
            delegationInfo.intendedProjectType = intendedProjectPledgeAdmin.type;
          }
        }

        // Set giverAddress to owner address if is a Giver
        if (giverAddress === undefined) {
          if (toOwnerAdmin.type !== 'Giver') {
            terminateScript(`Cannot set giverAddress`);
            return;
          }
          giverAddress = toPledgeAdmin.typeId;
          expectedToDonation.giverAddress = giverAddress;
        }

        if (status === null) {
          terminateScript(`Pledge status ${toPledge.pledgeState} is unknown`);
          return;
        }

        const { timestamp } = await foreignWeb3.eth.getBlock(blockNumber);

        const model = {
          status,
          mined: true,
          parentDonations: expectedToDonation.parentDonations,
          isReturn: false,
          giverAddress,
          amount: expectedToDonation.amount,
          amountRemaining: transfer.amountRemaining
            ? transfer.amountRemaining
            : expectedToDonation.amountRemaining.toFixed(),
          pledgeId: to,
          ownerId: toPledgeAdmin.id,
          ownerTypeId: toPledgeAdmin.typeId,
          ownerType: toPledgeAdmin.type,
          token,
          txHash: transactionHash,
          createdAt: new Date(timestamp * 1000),
          ...delegationInfo,
        };

        const { cutoff } = symbolDecimalsMap[token.symbol];
        model.lessThanCutoff = cutoff.gt(model.amountRemaining);

        if (transfer._id) {
          model._id = transfer._id;
        }
        const donation = new Donations(model);

        await donationUsdValueUtility.setDonationUsdValue(donation);

        await donation.save();

        const _id = donation._id.toString();
        expectedToDonation._id = _id;
        expectedToDonation.savedAmountRemaining = model.amountRemaining;
        donationMap.set(_id, expectedToDonation);
        logger.info(
          `donation created: ${JSON.stringify(
            {
              ...expectedToDonation,
              amountRemaining: expectedToDonation.amountRemaining.toFixed(),
            },
            null,
            2,
          )}`,
        );
      } else {
        logger.info(
          `this donation should be created: ${JSON.stringify(
            {
              ...expectedToDonation,
              amountRemaining: expectedToDonation.amountRemaining.toFixed(),
            },
            null,
            2,
          )}`,
        );
        logger.debug('--------------------------------');
        logger.debug(`From owner: ${fromOwnerAdmin}`);
        logger.debug(`To owner:${toOwnerAdmin}`);
        logger.debug('--------------------------------');
        logger.debug(`From pledge: ${fromPledge}`);
        logger.debug(`To pledge: ${toPledge}`);
      }
      let candidates = candidateDonationList.get(to);
      if (candidates === undefined) {
        candidates = [];
        candidateDonationList.set(to, candidates);
      }
      candidates.push(expectedToDonation);
      candidates = chargedDonationList.get(to);
      if (candidates === undefined) {
        candidates = [];
        chargedDonationList.set(to, candidates);
      }
      candidates.push(expectedToDonation);
    }
  } else {
    // Check toDonation has correct status and mined flag
    const expectedStatus = convertPledgeStateToStatus(toPledge, toOwnerAdmin);
    if (expectedStatus === null) {
      terminateScript(`Pledge status ${toPledge.pledgeState} is unknown`);
      return;
    }

    if (toDonation.mined === false) {
      logger.error(`Donation ${toDonation._id} mined flag should be true`);
      logger.debug('Updating...');
      await Donations.update({ _id: toDonation._id }, { mined: true }).exec();
    } else if (toDonation.status !== expectedStatus) {
      // logger.error(
      //   `Donation ${toDonation._id} status should be ${expectedStatus} but is ${toDonation.status}`,
      // );
    }

    const { parentDonations } = toDonation;
    if (
      updateParents &&
      (usedFromDonations.length !== parentDonations.length ||
        usedFromDonations.some(id => !parentDonations.includes(id)))
    ) {
      logger.error(`Parent of ${toDonation._id} should be updated to ${usedFromDonations}`);
      if (fixConflicts) {
        logger.debug('Updating...');
        toDonation.parentDonations = usedFromDonations;
        await Donations.update(
          { _id: toDonation._id },
          { parentDonations: usedFromDonations },
        ).exec();
      }
    }

    toDonation.amountRemaining = toDonation.amountRemaining.plus(amount);
    toDonation.txHash = transactionHash;
    toDonation.from = from;
    toDonation.pledgeId = to;
    toDonation.pledgeState = toPledge.pledgeState;
    toDonation.amountRemaining = new BigNumber(amount);
    const { PAYING, FAILED, PAID } = DonationStatus;
    // Just update Paying, Paid and Failed donations at this stage, other status may be changed
    // by future events
    if (
      [PAID, PAYING, FAILED].includes(toDonation.status) ||
      [PAYING, PAID].includes(expectedStatus)
    ) {
      if (expectedStatus !== toDonation.status) {
        logger.error(`Donation status is ${toDonation.status}, but should be ${expectedStatus}`);
        if (fixConflicts) {
          logger.debug('Updating...');
          await Donations.update({ _id: toDonation._id }, { status: expectedStatus }).exec();
          toDonation.status = expectedStatus;
        }
      }
    }

    let candidates = chargedDonationList.get(to);

    if (candidates === undefined) {
      candidates = [];
      chargedDonationList.set(to, candidates);
    }

    candidates.push(toDonation);

    logger.debug(
      `Amount added to ${JSON.stringify(
        {
          _id: toDonation._id,
          amountRemaining: toDonation.amountRemaining.toFixed(),
          amount: toDonation.amount,
          status: toDonation.status,
        },
        null,
        2,
      )}`,
    );

    // The project is cancelled, the donatoin should be reverted
    // if (toDonation.status === DonationStatus.CANCELED) {
    //   console.log(`Reverting donation to ${from}`);
    //   let fromUnusedDonationList =  pledgeNotFilledDonations.get(from); // List of donations which are candidates to money return to
    //   if (fromUnusedDonationList === undefined) {
    //     console.log(`There is no donation for pledgeId ${from}`);
    //     fromUnusedDonationList = [];
    //      pledgeNotFilledDonations.set(from, fromUnusedDonationList);
    //   }
    //
    //   const returnIndex = fromUnusedDonationList.findIndex(
    //     item =>
    //       item.amountRemaining.eq(0) &&
    //       item.amount === amount &&
    //       item.parentDonations.length === 1 &&
    //       item.parentDonations[0].toString() === toDonation._id.toString(),
    //   );
    //
    //   const returnDonation =
    //     returnIndex !== -1 ? fromUnusedDonationList.splice(returnIndex, 1)[0] : undefined;
    //   if (returnDonation === undefined) {
    //     process.stdout.write("could'nt find return donation", () => {
    //       process.exit();
    //     });
    //   }
    //   returnDonation.amountRemaining = returnDonation.amountRemaining.plus(amount);
    //   const returnChargedDonation = {
    //     _id: returnDonation._id,
    //     status: returnDonation.status,
    //     txHash: transactionHash,
    //     parentDonations: returnDonation.parentDonations,
    //     from,
    //     pledgeId: to,
    //     pledgeState: toPledge.pledgeState,
    //     amount,
    //     amountRemaining: new BigNumber(amount),
    //   };
    //
    //   let fromChargedDonationList = chargedDonationList.get(from);
    //
    //   if (fromChargedDonationList === undefined) {
    //     fromChargedDonationList = [];
    //     chargedDonationList.set(to, fromChargedDonationList);
    //   }
    //
    //   fromChargedDonationList.push(returnChargedDonation);
    //
    //   console.log(
    //     `Amount added to ${JSON.stringify(
    //       {
    //         _id: returnDonation._id,
    //         amountRemaining: returnDonation.amountRemaining.toFixed(),
    //         amount: returnDonation.amount,
    //         status: returnDonation.status,
    //       },
    //       null,
    //       2,
    //     )}`,
    //   );
    // }
  }
};
// const getMostRecentDonationNotCanceled = (donation, donationMap, admins) => {
//   // givers can never be canceled
//   if (donation.ownerType === AdminTypes.GIVER && !donation.intendedProjectId) {
//     return donation;
//   }
//
//   const pledgeOwnerAdmin = admins[Number(donation.ownerId)];
//
//   // if pledgeOwnerAdmin is canceled or donation is a delegation, go back 1 donation
//   if (pledgeOwnerAdmin.isCanceled || Number(donation.intendedProjectId) > 0) {
//     // we use the 1st parentDonation b/c the owner of all parentDonations
//     // is the same
//     return getMostRecentDonationNotCanceled(
//       donationMap.get(donation.parentDonations[0]),
//       donationMap,
//       admins,
//     );
//   }
//
//   return donation;
// };

// const revertDonation = async (
//   donation,
//   transactionHash,
//   donationMap,
//   pledgeNotFilledDonations,
//   toCreateDonationListMap,
//   chargedDonationListMap,
//   admins,
// ) => {
//   // They should not be processed in regular donation reverting process
//   // if (revertExemptedDonations.includes(donation._id)) return;
//   if ([DonationStatus.PAYING, DonationStatus.PAID].includes(donation.status)) return;
//
//   const revertToDonation = getMostRecentDonationNotCanceled(donation, donationMap, admins);
//   const toPledgeNotFilledDonationList = pledgeNotFilledDonations.get(revertToDonation.pledgeId);
//   if (toPledgeNotFilledDonationList === undefined) {
//     terminateScript(`No pledge found to move money to`);
//     return;
//   }
//   const toIndex = toPledgeNotFilledDonationList.findIndex(
//     item =>
//       item.txHash === transactionHash &&
//       item.parentDonations.length === 1 &&
//       (donation._id === undefined || item.parentDonations[0] === donation._id),
//   );
//
//   if (toIndex === -1) {
//     terminateScript(
//       `Couldn't find donation to move money of ${JSON.stringify(donation, null, 2)}`,
//     );
//     return;
//   }
//
//   const toDonation =
//     toIndex !== -1 ? toPledgeNotFilledDonationList.splice(toIndex, 1)[0] : undefined;
//
//   toDonation.amountRemaining = toDonation.amountRemaining.plus(donation.amountRemaining);
//   donation.amountRemaining = new BigNumber(0);
//
//   // TODO: It happens and should be fixed
//   // if (toDonation.amountRemaining.gt(toDonation.amount)) {
//   //   terminateScript(
//   //     `Donation amountRemaining exceeds its amount!\n${JSON.stringify(
//   //       { ...toDonation, amountRemaining: toDonation.amountRemaining.toFixed() },
//   //       null,
//   //       2,
//   //     )}`,
//   //   );
//   //   return;
//   // }
//
//   toDonation.from = donation.pledgeId;
//
//   let chargedDonationList = chargedDonationListMap.get(toDonation.pledgeId);
//
//   if (chargedDonationList === undefined) {
//     chargedDonationList = [];
//     chargedDonationListMap.set(toDonation.pledgeId, chargedDonationList);
//   }
//
//   chargedDonationList.push(toDonation);
//
//   chargedDonationList = chargedDonationListMap.get(donation.pledgeId) || [];
//
//   const fromIndex = chargedDonationList.findIndex(item => item._id === donation._id);
//   if (fromIndex !== -1) chargedDonationList.splice(fromIndex, 1);
//
//   console.log(
//     `Revert money from ${donation.pledgeId} to ${
//       toDonation.pledgeId
//     } amount ${toDonation.amountRemaining.toFixed()}`,
//   );
//   if (donation.status !== DonationStatus.CANCELED) {
//     console.log(`Donation status should be ${DonationStatus.CANCELED}, but is ${donation.status}`);
//     if (fixConflicts) {
//       console.log('Updating...');
//       await Donations.update({ _id: donation._id }, { status: DonationStatus.CANCELED }).exec();
//       toDonation.status = DonationStatus.CANCELED;
//     }
//   }
//
//   const { _id, amount, amountRemaining } = toDonation;
//   if (!amountRemaining.eq(amount)) {
//     console.log(`Donation ${_id} amount should be ${amountRemaining.toFixed()} but is ${amount}`);
//     if (fixConflicts) {
//       console.log('Updating...');
//       const { cutoff } = symbolDecimalsMap[donation.token.symbol];
//       await Donations.update(
//         { _id },
//         { amount: amountRemaining.toFixed(), lessThanCutoff: cutoff.gt(amountRemaining) },
//       ).exec();
//       toDonation.amount = amountRemaining.toFixed();
//     }
//   }
//
//   console.log(
//     `Amount added to ${JSON.stringify(
//       {
//         ...toDonation,
//         amountRemaining: toDonation.amountRemaining.toFixed(),
//       },
//       null,
//       2,
//     )}`,
//   );
// };

// // eslint-disable-next-line no-unused-vars
// const revertProjectDonations = (
//   projectId,
//   transactionHash,
//   donationMap,
//   ownerPledgeList,
//   pledgeNotFilledDonations,
//   toCreateDonationListMap,
//   chargedDonationListMap,
//   admins,
// ) => {
//   const projectPledgesList = ownerPledgeList.get(projectId.toString()) || [];
//   return Promise.all(
//     projectPledgesList.map(pledgeId => {
//       const chargedDonationList = chargedDonationListMap.get(String(pledgeId)) || [];
//       return Promise.all(
//         [...chargedDonationList].map(chargedDonation =>
//           revertDonation(
//             chargedDonation,
//             transactionHash,
//             donationMap,
//             pledgeNotFilledDonations,
//             toCreateDonationListMap,
//             chargedDonationListMap,
//             admins,
//           ),
//         ),
//       );
//     }),
//   );
// };

const cancelProject = async (
  projectId,
  transactionHash,
  donationMap,
  ownerPledgeList,
  campaignMilestoneListMap,
  pledgeNotFilledDonations,
  toCreateDonationListMap,
  chargedDonationListMap,
  admins,
) => {
  admins[projectId].isCanceled = true;
  const projectIdStr = String(projectId);
  admins.slice(1).forEach(admin => {
    if (admin.parentProject === projectIdStr) {
      admin.isCanceled = true;
    }
  });

  /* TODO: We should not revert project donations when the project is cancelled!
   * We should wait for transfer event to be emitted. This logic should be implemented
   * in feathers-giveth core too.
   */

  // Cancel campaign milestones
  // if (campaignMilestoneListMap.has(projectId)) {
  //   const milestoneList = campaignMilestoneListMap.get(projectId) || [];
  //   await Promise.all(
  //     milestoneList.map(id => {
  //       return revertProjectDonations(
  //         id,
  //         transactionHash,
  //         donationMap,
  //         ownerPledgeList,
  //         pledgeNotFilledDonations,
  //         toCreateDonationListMap,
  //         chargedDonationListMap,
  //         admins,
  //       );
  //     }),
  //   );
  // }
  //
  // await revertProjectDonations(
  //   projectId,
  //   transactionHash,
  //   donationMap,
  //   ownerPledgeList,
  //   pledgeNotFilledDonations,
  //   toCreateDonationListMap,
  //   chargedDonationListMap,
  //   admins,
  // );
};

const fixConflictInDonations = (donationMap, pledges, unusedDonationMap) => {
  const promises = [];
  donationMap.forEach(
    ({ _id, amount, amountRemaining, savedAmountRemaining, status, pledgeId, txHash, token }) => {
      if (pledgeId === '0') return;

      const pledge = pledges[Number(pledgeId)];

      if (unusedDonationMap.has(_id.toString())) {
        logger.error(
          `Donation was unused!\n${JSON.stringify(
            {
              _id,
              amount: amount.toString(),
              amountRemaining: amountRemaining.toString(),
              status,
              pledgeId: pledgeId.toString(),
              pledgeOwner: pledge.owner,
              txHash,
            },
            null,
            2,
          )}`,
        );
        if (fixConflicts) {
          logger.debug('Deleting...');
          promises.push(Donations.findOneAndDelete({ _id }).exec());
        }
      } else if (savedAmountRemaining && !amountRemaining.eq(savedAmountRemaining)) {
        logger.error(
          `Below donation should have remaining amount ${amountRemaining.toFixed()} but has ${savedAmountRemaining}\n${JSON.stringify(
            {
              _id,
              amount: amount.toString(),
              amountRemaining: amountRemaining.toFixed(),
              status,
              pledgeId: pledgeId.toString(),
              txHash,
            },
            null,
            2,
          )}`,
        );
        if (Number(pledgeId) !== 0) {
          logger.info(`Pledge Amount: ${pledge.amount}`);
        }
        if (fixConflicts) {
          logger.debug('Updating...');
          const { cutoff } = symbolDecimalsMap[token.symbol];
          promises.push(
            Donations.update(
              { _id },
              {
                $set: {
                  amountRemaining: amountRemaining.toFixed(),
                  lessThanCutoff: cutoff.gt(amountRemaining),
                },
              },
            ).exec(),
          );
        }
      }
    },
  );
  return Promise.all(promises);
};

const syncDonationsWithNetwork = async (events, pledges, admins) => {
  // Map from pledge id to list of donations belongs to which are not used yet!
  const {
    pledgeDonationListMap: pledgeNotFilledDonations,
    donationMap,
  } = await getPledgeDonationItems();

  // Donations which are candidate to be created
  const toCreateDonationListMap = new Map();
  // Donations which are charged and can be used to move money from
  const chargedDonationListMap = new Map();
  // Map from owner to list of its pledges
  const ownerPledgeList = new Map();
  // Map from campaign to list of its milestones
  const campaignMilestoneListMap = new Map();

  for (let i = 1; i < pledges.length; i += 1) {
    const { owner } = pledges[i];
    let list = ownerPledgeList.get(owner);
    if (list === undefined) {
      list = [];
      ownerPledgeList.set(owner, list);
    }
    list.push(i);
  }

  for (let i = 1; i < admins.length; i += 1) {
    const { parentProject } = admins[i];
    if (parentProject !== '0') {
      let list = campaignMilestoneListMap.get(parentProject);
      if (list === undefined) {
        list = [];
        campaignMilestoneListMap.set(parentProject, list);
      }
      list.push(i);
    }
  }

  const foreignWeb3 = instantiateWeb3(nodeUrl);
  // Simulate transactions by events
  for (let i = 0; i < events.length; i += 1) {
    const { event, transactionHash, logIndex, returnValues, blockNumber } = events[i];
    logger.debug(
      `-----\nProcessing event ${i}:\nLog Index: ${logIndex}\nEvent: ${event}\nTransaction hash: ${transactionHash}`,
    );

    if (ignoredTransactions.some(it => it.txHash === transactionHash && it.logIndex === logIndex)) {
      logger.debug('Event ignored.');
      continue;
    }

    if (event === 'Transfer') {
      const { from, to, amount } = returnValues;
      logger.debug(`Transfer from ${from} to ${to} amount ${amount}`);

      // eslint-disable-next-line no-await-in-loop
      const { usedFromDonations, isIgnored, giverAddress } = await handleFromDonations(
        from,
        to,
        amount,
        transactionHash,
        logIndex,
        pledges,
        admins,
        pledgeNotFilledDonations,
        chargedDonationListMap,
        donationMap,
      );

      // eslint-disable-next-line no-await-in-loop
      await handleToDonations(
        from,
        to,
        amount,
        foreignWeb3,
        transactionHash,
        blockNumber,
        logIndex,
        pledges,
        admins,
        pledgeNotFilledDonations,
        toCreateDonationListMap,
        chargedDonationListMap,
        usedFromDonations,
        isIgnored,
        giverAddress,
        donationMap,
      );
    } else if (event === 'CancelProject') {
      const { idProject } = returnValues;
      logger.debug(`Cancel project ${idProject}: ${JSON.stringify(admins[Number(idProject)])}`);
      // eslint-disable-next-line no-await-in-loop
      await cancelProject(
        idProject,
        transactionHash,
        donationMap,
        ownerPledgeList,
        campaignMilestoneListMap,
        pledgeNotFilledDonations,
        toCreateDonationListMap,
        chargedDonationListMap,
        admins,
      );
    }
  }

  // Find conflicts in donations and pledges!
  chargedDonationListMap.forEach((list, pledgeId) => {
    const reducer = (totalAmountRemaining, chargedDonation) => {
      return totalAmountRemaining.plus(chargedDonation.amountRemaining);
    };
    const totalAmountRemaining = list.reduce(reducer, new BigNumber(0));
    const { amount: pledgeAmount, owner, oldPledge, pledgeState } = pledges[Number(pledgeId)];
    const admin = admins[Number(owner)];
    const { isCanceled, canceled } = admin;

    if (!totalAmountRemaining.eq(pledgeAmount)) {
      logger.error(
        `Pledge ${pledgeId} amount ${pledgeAmount} does not equal total amount remaining ${totalAmountRemaining.toFixed()}`,
      );
      logger.debug({
        PledgeState: pledgeState,
        'Old Pledge': oldPledge,
        Owner: owner,
        'Owner canceled': !!canceled,
        'Owner isCanceled': !!isCanceled,
      });
    } else if (isCanceled && !['Paying', 'Paid'].includes(pledgeState)) {
      logger.info(
        `Pledge ${pledgeId} owner is canceled and its amount equals total amount remaining ${totalAmountRemaining.toFixed()}`,
      );
      logger.debug(
        JSON.stringify(
          {
            PledgeState: pledgeState,
            'Old Pledge': oldPledge,
            Owner: owner,
            'Owner canceled': !!canceled,
            'Owner isCanceled': !!isCanceled,
          },
          null,
          2,
        ),
      );
    }
  });

  const unusedDonationMap = new Map();
  pledgeNotFilledDonations.forEach(list =>
    list.forEach(item => unusedDonationMap.set(item._id, item)),
  );
  await fixConflictInDonations(donationMap, pledges, unusedDonationMap);
};

// Creates PledgeAdmins entity for a project entity
// Requires corresponding project entity has been saved holding correct value of txHash
// eslint-disable-next-line no-unused-vars
const syncPledgeAdmins = async events => {
  if (!fixConflicts) return;

  for (let i = 9000; i < events.length; i += 1) {
    const { event, transactionHash, returnValues } = events[i];

    if (event !== 'ProjectAdded') continue;

    const { idProject } = returnValues;

    // eslint-disable-next-line no-await-in-loop
    const [pledgeAdmin] = await PledgeAdmins.find({ id: Number(idProject) }).exec();

    if (pledgeAdmin === undefined) {
      logger.error(`No pledge admin exists for ${idProject}`);
      logger.info('Transaction Hash:', transactionHash);

      const projectModelTypeField = [
        {
          type: AdminTypes.DAC,
          model: DACs,
          idFieldName: 'delegateId',
          expectedStatus: DacStatus.ACTIVE,
        },
        {
          type: AdminTypes.CAMPAIGN,
          model: Campaigns,
          idFieldName: 'projectId',
          expectedStatus: CampaignStatus.ACTIVE,
        },
        {
          type: AdminTypes.MILESTONE,
          model: Milestones,
          idFieldName: 'projectId',
          expectedStatus: MilestoneStatus.IN_PROGRESS,
        },
      ];

      let entityFound = false;
      for (let j = 0; j < projectModelTypeField.length; j += 1) {
        const { type, model, idFieldName, expectedStatus } = projectModelTypeField[j];
        // eslint-disable-next-line no-await-in-loop
        const [entity] = await model.find({ txHash: transactionHash }).exec();

        // Not found any
        if (entity === undefined) continue;

        logger.info(`a ${type} found with id ${entity._id.toString()} and status ${entity.status}`);
        logger.info(`Title: ${entity.title}`);
        const newPledgeAdmin = new PledgeAdmins({
          id: Number(idProject),
          type,
          typeId: entity._id.toString(),
        });
        // eslint-disable-next-line no-await-in-loop
        await newPledgeAdmin.save();
        logger.info(`pledgeAdmin crated: ${newPledgeAdmin._id.toString()}`);

        const mutation = {};
        mutation[idFieldName] = Number(idProject);

        // eslint-disable-next-line no-await-in-loop
        await model
          .update(
            { _id: entity.id },
            {
              status: expectedStatus,
              prevStatus: entity.status,
              $set: {
                ...mutation,
              },
            },
          )
          .exec();

        entityFound = true;
        break;
      }

      if (!entityFound) {
        logger.error("Couldn't found appropriate entity");
      }
    }
  }
};

const main = async () => {
  try {
    const { state, events } = await getBlockchainData();

    if (!findConflicts && !fixConflicts) {
      terminateScript(null, 0);
      return;
    }

    const { pledges, admins } = state;

    /*
     Find conflicts in milestone donation counter
    */
    const mongoUrl = config.mongodb;
    mongoose.connect(mongoUrl);
    const db = mongoose.connection;

    db.on('error', err => logger.error(`Could not connect to Mongo:\n${err.stack}`));

    db.once('open', () => {
      logger.info('Connected to Mongo');

      Promise.all([
        syncDonationsWithNetwork(events, pledges, admins),
        // syncPledgeAdmins(events, admins),
        // updateDonationsCreatedDate(new Date('2020-02-01')),
      ]).then(() => terminateScript(null, 0));
    });
  } catch (e) {
    logger.error(e);
    throw e;
  }
};

main()
  .then(() => {})
  .catch(e => terminateScript(e, 1));
