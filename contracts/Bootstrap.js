const { Base64 } = require('js-base64');
const { Transaction } = require('../libs/Transaction');

class Bootstrap {
  static getBootstrapTransactions(genesisSteemBlock) {
    const transactions = [];

    // accounts contract
    let contractCode = `
    actions.createSSC = async (payload) => {
      await db.createTable('accounts', ['id']);
    }

    // register an account helps other contracts to know 
    // if an account exists on the Steem blockchain
    actions.register = async (payload) => {
      const account = await db.findOne('accounts', { 'id': sender });

      if (account === null) {
        const newAccount = {
          'id': sender
        };

        await db.insert('accounts', newAccount);
      } 
    }
    `;

    let base64ContractCode = Base64.encode(contractCode);

    let contractPayload = {
      name: 'accounts',
      params: '',
      code: base64ContractCode,
    };

    transactions.push(new Transaction(genesisSteemBlock, 0, 'null', 'contract', 'deploy', JSON.stringify(contractPayload)));

    // tokens contract
    contractCode = `
      actions.createSSC = async (payload) => {
        await db.createTable('tokens', ['symbol']);
        await db.createTable('balances', ['account']);
      }

      actions.create = async (payload) => {
        const { symbol, precision, maxSupply } = payload;

        if (symbol && typeof symbol === 'string'
          && (precision && typeof precision === 'number' || precision === 0)
          && maxSupply && typeof maxSupply === 'number') {

          // the symbol must be made of letters only
          // the precision must be between 0 and 8 and must be an integer
          // the max supply must be positive
          if (assert(validator.isAlpha(symbol), 'invalid symbol')
            && assert((precision >= 0 && precision <= 8) && (Number.isInteger(precision)), 'invalid precision')
            && assert(maxSupply > 0, 'maxSupply must be positive')) {

            // check if the token already exists
            let token = await db.findOne('tokens', { symbol });

            if (assert(token === null, 'symbol already exists')) {
              const newToken = {
                issuer: sender,
                symbol,
                precision,
                maxSupply,
                supply: 0
              };
              
              await db.insert('tokens', newToken);
            }
          }
        }
      }

      actions.issue = async (payload) => {
        const { to, symbol, quantity, isSignedWithActiveKey } = payload;

        if (assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
          && to && typeof to === 'string'
          && symbol && typeof symbol === 'string'
          && quantity && typeof quantity === 'number') {

          let token = await db.findOne('tokens', { symbol });

          // the symbol must exist
          // the sender must be the issuer
          // then we need to check that the quantity is correct
          if (assert(token !== null, 'symbol does not exist')
            && assert(token.issuer === sender, 'not allowed to issue tokens')
            && assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
            && assert(quantity > 0, 'must issue positive quantity')
            && assert(quantity <= (token.maxSupply - token.supply), 'quantity exceeds available supply')) {

            let account = await db.findOneInTable('accounts', 'accounts', { 'id': to });

            // the account must have been registered before
            if (assert(account !== null, 'to account does not exist')) {
              // we made all the required verification, let's now issue the tokens

              token.supply = calculateBalance(token.supply, quantity, token.precision, true);
              
              await db.update('tokens', token);

              await addBalance(token.issuer, token, quantity);

              if (to !== token.issuer) {
                await actions.transfer(payload);
              }
            }
          }
        }
      }

      actions.transfer = async (payload) => {
        const { to, symbol, quantity, isSignedWithActiveKey } = payload;

        if (assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
          && to && typeof to === 'string'
          && symbol && typeof symbol === 'string'
          && quantity && typeof quantity === 'number') {

          if (assert(to !== sender, 'cannot transfer to self')) {
            let account = await db.findOneInTable('accounts', 'accounts', { 'id': to });
      
            // the account must have been registered before
            if (assert(account !== null, 'to account does not exist')) {
              let token = await db.findOne('tokens', { symbol });

              // the symbol must exist
              // then we need to check that the quantity is correct
              if (assert(token !== null, 'symbol does not exist')
                && assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
                && assert(quantity > 0, 'must transfer positive quantity')) {

                if (await subBalance(sender, token, quantity)) {
                  await addBalance(to, token, quantity);
                }
              }
            }
          }
        }
      }

      const subBalance = async (account, token, quantity) => {
        let balance = await db.findOne('balances', { account, 'symbol': token.symbol });
        if (assert(balance !== null, 'balance does not exist') &&
          assert(balance.balance >= quantity, 'overdrawn balance')) {

          balance.balance = calculateBalance(balance.balance, quantity, token.precision, false);

          if (balance.balance <= 0) {
            await db.remove('balances', balance);
          } else {
            await db.update('balances', balance);
          }

          return true;
        }

        return false;
      }

      const addBalance = async (account, token, quantity) => {
        let balance = await db.findOne('balances', { account, 'symbol': token.symbol });
        if (balance === null) {
          balance = {
            account,
            'symbol': token.symbol,
            'balance': quantity
          }
          
          await db.insert('balances', balance);
        } else {
          balance.balance = calculateBalance(balance.balance, quantity, token.precision, true);

          await db.update('balances', balance);
        }
      }

      const calculateBalance = function (balance, quantity, precision, add) {
        if (precision === 0) {
          return add ? balance + quantity : balance - quantity
        }

        return add ? currency(balance, { precision }).add(quantity) : currency(balance, { precision }).subtract(quantity);
      }

      const countDecimals = function (value) {
        if (Math.floor(value) === value) return 0;
        return value.toString().split('.')[1].length || 0;
      }
    `;

    base64ContractCode = Base64.encode(contractCode);

    contractPayload = {
      name: 'tokens',
      params: '',
      code: base64ContractCode,
    };

    transactions.push(new Transaction(genesisSteemBlock, 0, 'null', 'contract', 'deploy', JSON.stringify(contractPayload)));

    // sscstore contract
    contractCode = `
    actions.createSSC = async (payload) => {
      await db.createTable('params');
      const params = {};
      
      params.priceSBD = 0.001;
      params.priceSteem = 0.001;
      params.quantity = 1;
      params.disabled = false;

      await db.insert('params', params);      
    }

    actions.updateParams = async (payload) => {
      if (sender !== owner) return;

      const { priceSBD, priceSteem, quantity, disabled } = payload;

      const params = await db.findOne('params', { });

      params.priceSBD = priceSBD;
      params.priceSteem = priceSteem;
      params.quantity = quantity;
      params.disabled = disabled;

      await db.update('params', params);
    }

    actions.buy = async (payload) => {
      const { recipient, amountSTEEMSBD, isSignedWithActiveKey } = payload;

      if (recipient !== owner) return;

      if (recipient && amountSTEEMSBD && isSignedWithActiveKey) {
        const params = await db.findOne('params', { });

        if (params.disabled) return;

        const res = amountSTEEMSBD.split(' ');
  
        const amount = res[0];
        const unit = res[1];
  
        let quantity = 0;
        let quantityToSend = 0;
        // STEEM
        if (unit === 'STEEM') {
          quantity = currency(Number(amount), { precision: 3 }).divide(params.priceSteem);
        } 
        // SBD
        else {
          quantity = currency(Number(amount), { precision: 3 }).divide(params.priceSBD);
        }
  
        quantityToSend = currency(quantity, { precision: 8 }).multiply(params.quantity);
  
        if (quantityToSend.value > 0) {
          await executeSmartContractAsOwner('tokens', 'transfer', { symbol: "SSC", quantity: quantityToSend.value, to: sender })
        }
      }
    }
    `;

    base64ContractCode = Base64.encode(contractCode);

    contractPayload = {
      name: 'sscstore',
      params: '',
      code: base64ContractCode,
    };

    transactions.push(new Transaction(genesisSteemBlock, 0, 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));


    // bootstrap transactions
    transactions.push(new Transaction(genesisSteemBlock, 0, 'null', 'accounts', 'register'));
    transactions.push(new Transaction(genesisSteemBlock, 0, 'steemsc', 'accounts', 'register'));

    return transactions;
  }
}

module.exports.Bootstrap = Bootstrap;