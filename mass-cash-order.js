#!/usr/bin/env node

import fs from 'fs';
import csv from 'csv-parser';
import progress from 'cli-progress';
import {
  Order,
  Customer,
  NearbyStores,
  Item,
  Address
} from 'dominos';

// CONFIG

const CONFIG = {
  // default customer info (will be used for every order unless overridden in CSV and will also be used for any info not provided)
  firstName: 'Nathaniel',
  lastName:  'Higgers',
  email:     'cpninfo2006@gmail.com',
  phone:     '248-434-5508',       // Must be a real phone; Domino’s will text/call

  // cheap items that usually keep the total within cash pay limits
  cheapItems: [
    { code: '14SCEXTRAV', qty: 1 },      // 14" Extravagan'Za
    // or use something cheaper:
    // { code: '12SCREEN',  qty: 1 },   // medium hand-tossed cheese
    // { code: 'B8PCZA',    qty: 2 },   // 2 medium 1-topping
  ],

  // max to spend per address (including tax + delivery)
  maxTotalDollars: 44.99,

  // how long to wait between orders (cuz Dominoe’s will block you if you are too fast)
  delayBetweenOrdersMs: 10000, // 10 seconds is usually safe

  //how many times it'll retry
  maxRetries: 2,

  // input file (CSV or JSON works)
  inputFile: 'addresses.csv', // or 'addresses.json'

  // output log
  logFile: 'order-log.json'
};

const results = [];
const bar = new progress.SingleBar({}, progress.Presets.shades_classic);

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomDelay(min, max) {
  return sleep(min + Math.random() * (max - min));
}

// monkeypatch HTTP headers to look more human
const originalFetch = global.fetch || require('node-fetch'); // fallback if needed
global.fetch = async (url, options = {}) => {
  const headers = {
    ...options.headers,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin'
  };
  return originalFetch(url, { ...options, headers });
};

async function processAddress(row, retryCount = 0) {
  const fullStreetAddress = `${row.street}, ${row.city}, ${row.region} ${row.postalCode}`;
  const addressObj = new Address({ street: row.street, city: row.city, region: row.region, postalCode: row.postalCode });
  const customer = new Customer({
    firstName: row.firstName || CONFIG.firstName,
    lastName:  row.lastName  || CONFIG.lastName,
    email:     row.email     || CONFIG.email,
    phone:     row.phone     || CONFIG.phone,
    address: addressObj
  });

  try {
    const nearby = await new NearbyStores(addressObj);
    const store = nearby.stores
      .filter(s => s.IsOpen && s.IsDeliveryStore && s.ServiceIsOpen?.Delivery)
      .sort((a, b) => a.MinDistance - b.MinDistance)[0];

    if (!store) throw new Error('No open delivery store found');

    const order = new Order(customer);
    order.storeID = store.StoreID;

    CONFIG.cheapItems.forEach(item => {
      for (let i = 0; i < item.qty; i++) {
        order.addItem(new Item({ code: item.code }));
      }
    });

    await order.validate();
    await order.price();

    const total = order.amountsBreakdown?.customer || 0;
    if (total > CONFIG.maxTotalDollars || total === 0) {
      throw new Error(`Invalid total: $${total.toFixed(2)}`);
    }

    // cash setup
    order.payments = [{ type: 'Cash', tenderType: 'Cash', amount: total }];

    const placeResult = await order.place();

    results.push({
      address: fullStreetAddress,
      total: total.toFixed(2),
      storeID: store.StoreID,
      orderID: placeResult?.Order?.OrderID || 'N/A',
      status: 'SUCCESS',
      time: new Date().toISOString()
    });
    console.log(`\nSUCCESS!: $${total.toFixed(2)} cash pizza → ${fullStreetAddress} (ID: ${placeResult?.Order?.OrderID || 'Pending'})`);

  } catch (err) {
      const msg = err.message || err.toString();

      if (msg.includes('recaptcha') || msg.includes('PriceInformationRemoved') || msg.includes('Failure')) {
        console.log(`\nIP BLOCKED... Dominoes triggered reCAPTCHA on this IP.`);
        console.log(`To fix it create a new Codespace or Replit or switch to home Wi-Fi/mobile hotspot o algo. Also you can try and warm up the IP by doing an order manually or however the 'za is ordered.\n`);
        results.push({
          address: fullStreetAddress,
          error: 'IP_BLOCKED_RECAPTCHA — ' + msg,
          status: 'BLOCKED',
          time: new Date().toISOString()
        });
        return;  // skip retries, move to next address
      }

    results.push({
      address: fullStreetAddress,
      error: fullError,
      status: 'FAILED',
      retryCount,
      time: new Date().toISOString()
    });
    console.log(`\nFAILED: ${fullStreetAddress} — ${fullError}`);
  }
}

async function main() {
  console.log('DER ZANNON\n');
  console.log('Like the Manhattan Project except for pedophiles instead of japanese.\n');

  const addresses = [];
  await new Promise((res, rej) => {
    fs.createReadStream(CONFIG.inputFile).pipe(csv()).on('data', d => addresses.push(d)).on('end', res).on('error', rej);
  });

  if (addresses.length === 0) {
    console.log('No addresses in CSV.');
    return;
  }

  console.log(`Loaded ${addresses.length} addresses\n`);
  bar.start(addresses.length, 0);

  for (let i = 0; i < addresses.length; i++) {
    await processAddress(addresses[i]);
    bar.update(i + 1);
    if (i < addresses.length - 1) await randomDelay(CONFIG.baseDelayMs, CONFIG.baseDelayMs * 3); // 10–30s random
  }

  bar.stop();
  fs.writeFileSync(CONFIG.logFile, JSON.stringify(results, null, 2));
  console.log(`\n🎉 Done! Results in ${CONFIG.logFile} (Success: ${results.filter(r => r.status === 'SUCCESS').length}/${addresses.length})`);
}

main().catch(e => console.error('FATAL:', e));
