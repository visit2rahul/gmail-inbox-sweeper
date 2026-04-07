/**
 * Gmail Bulk Cleanup — Google Apps Script
 *
 * Functions:
 *   discoverSpam()       — Read-only recon. Shows top senders by volume.
 *   bulkCleanup()        — Trashes emails from blocked domains (skips Primary).
 *   purgeOldPromotions() — Trashes promotions older than configured threshold.
 *   dailyAutoClean()     — Runs both cleanup functions. Attach to a daily trigger.
 *   installTrigger()     — One-time: sets up the daily 3am trigger.
 *   removeTriggers()     — Removes all triggers created by this script.
 *
 * Configuration is stored in Script Properties (not hardcoded).
 * Run configureDefaults() once to initialize, then use updateBlockedDomains()
 * to manage your block list without editing code.
 */

// ============================================================
// CONFIGURATION — stored in Script Properties
// ============================================================

var CONFIG_KEYS = {
  BLOCK_DOMAINS: 'BLOCK_DOMAINS',         // JSON array of domain strings
  PROMO_MAX_AGE_DAYS: 'PROMO_MAX_AGE_DAYS', // days before promotions are trashed
  SCAN_WINDOW_DAYS: 'SCAN_WINDOW_DAYS'      // lookback window for discoverSpam
};

function configureDefaults() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty(CONFIG_KEYS.BLOCK_DOMAINS)) {
    props.setProperty(CONFIG_KEYS.BLOCK_DOMAINS, '[]');
  }
  if (!props.getProperty(CONFIG_KEYS.PROMO_MAX_AGE_DAYS)) {
    props.setProperty(CONFIG_KEYS.PROMO_MAX_AGE_DAYS, '7');
  }
  if (!props.getProperty(CONFIG_KEYS.SCAN_WINDOW_DAYS)) {
    props.setProperty(CONFIG_KEYS.SCAN_WINDOW_DAYS, '30');
  }
  Logger.log('Defaults configured. Current settings:');
  logCurrentConfig_();
}

function getBlockedDomains_() {
  var raw = PropertiesService.getScriptProperties().getProperty(CONFIG_KEYS.BLOCK_DOMAINS);
  return raw ? JSON.parse(raw) : [];
}

function getConfigInt_(key, fallback) {
  var val = PropertiesService.getScriptProperties().getProperty(key);
  return val ? parseInt(val, 10) : fallback;
}

function logCurrentConfig_() {
  var props = PropertiesService.getScriptProperties().getProperties();
  Object.keys(props).forEach(function(key) {
    Logger.log('  ' + key + ' = ' + props[key]);
  });
}

/**
 * Update blocked domains list.
 * Pass an array: updateBlockedDomains(['spam.com', 'junk.co'])
 * Or call with no args to see the current list.
 */
function updateBlockedDomains(domains) {
  var props = PropertiesService.getScriptProperties();
  if (domains && domains.length > 0) {
    var existing = getBlockedDomains_();
    var merged = existing.concat(domains.filter(function(d) {
      return existing.indexOf(d) === -1;
    }));
    props.setProperty(CONFIG_KEYS.BLOCK_DOMAINS, JSON.stringify(merged));
    Logger.log('Blocked domains updated (' + merged.length + ' total):');
    merged.forEach(function(d) { Logger.log('  ' + d); });
  } else {
    var current = getBlockedDomains_();
    Logger.log('Current blocked domains (' + current.length + '):');
    current.forEach(function(d) { Logger.log('  ' + d); });
  }
}

/**
 * Remove a domain from the block list.
 */
function unblockDomain(domain) {
  var props = PropertiesService.getScriptProperties();
  var current = getBlockedDomains_();
  var filtered = current.filter(function(d) { return d !== domain; });
  props.setProperty(CONFIG_KEYS.BLOCK_DOMAINS, JSON.stringify(filtered));
  Logger.log('Removed ' + domain + '. Remaining: ' + filtered.length);
}

// ============================================================
// STEP 1: DISCOVER — read-only recon
// ============================================================

function discoverSpam() {
  var senderCounts = {};
  var scanDays = getConfigInt_(CONFIG_KEYS.SCAN_WINDOW_DAYS, 30);

  var queries = [
    'category:promotions newer_than:' + scanDays + 'd',
    'category:updates newer_than:' + scanDays + 'd',
    'category:social newer_than:' + scanDays + 'd',
    'label:spam newer_than:' + scanDays + 'd'
  ];

  queries.forEach(function(query) {
    var threads = GmailApp.search(query, 0, 200);
    threads.forEach(function(thread) {
      var from = thread.getMessages()[0].getFrom();
      var match = from.match(/@([^\s>]+)/);
      var domain = match ? match[1].toLowerCase() : from;
      senderCounts[domain] = (senderCounts[domain] || 0) + thread.getMessageCount();
    });
  });

  var sorted = Object.keys(senderCounts).sort(function(a, b) {
    return senderCounts[b] - senderCounts[a];
  });

  Logger.log('=== TOP SENDERS (last ' + scanDays + ' days) ===');
  Logger.log('Use updateBlockedDomains([...]) to block any of these.\n');
  sorted.forEach(function(domain) {
    Logger.log(senderCounts[domain] + ' emails — ' + domain);
  });

  return senderCounts;
}

// ============================================================
// STEP 2: BULK CLEANUP — trashes emails from blocked domains
// ============================================================

function bulkCleanup() {
  var domains = getBlockedDomains_();
  if (domains.length === 0) {
    Logger.log('No blocked domains configured. Run discoverSpam() first, then updateBlockedDomains([...]).');
    return;
  }

  var startTime = new Date().getTime();
  var totalTrashed = 0;

  domains.forEach(function(domain) {
    // Safety: explicitly exclude Primary to never touch important emails
    var query = 'from:@' + domain + ' -category:primary';
    var threads = GmailApp.search(query, 0, 100);
    var count = 0;

    while (threads.length > 0) {
      threads.forEach(function(thread) {
        thread.moveToTrash();
        count++;
      });

      // Respect Apps Script 6-minute execution limit
      if (new Date().getTime() - startTime > 5 * 60 * 1000) {
        Logger.log('Approaching time limit. Stopping. Run again to continue.');
        totalTrashed += count;
        Logger.log('Trashed ' + count + ' threads from ' + domain);
        return;
      }

      threads = GmailApp.search(query, 0, 100);
    }

    totalTrashed += count;
    if (count > 0) {
      Logger.log('Trashed ' + count + ' threads from ' + domain);
    }
  });

  Logger.log('\nTotal: trashed ' + totalTrashed + ' threads');
}

// ============================================================
// STEP 3: PURGE OLD PROMOTIONS
// ============================================================

function purgeOldPromotions() {
  var maxAgeDays = getConfigInt_(CONFIG_KEYS.PROMO_MAX_AGE_DAYS, 7);
  var startTime = new Date().getTime();

  var query = 'category:promotions older_than:' + maxAgeDays + 'd';
  var threads = GmailApp.search(query, 0, 100);
  var count = 0;

  while (threads.length > 0) {
    threads.forEach(function(thread) {
      thread.moveToTrash();
      count++;
    });

    // Respect Apps Script 6-minute execution limit
    if (new Date().getTime() - startTime > 5 * 60 * 1000) {
      Logger.log('Approaching time limit (' + count + ' trashed). Run again to continue.');
      return;
    }

    threads = GmailApp.search(query, 0, 100);
  }

  Logger.log('Trashed ' + count + ' promotional threads older than ' + maxAgeDays + ' days.');
}

// ============================================================
// STEP 4: SCHEDULED AUTO-CLEANUP
// ============================================================

function dailyAutoClean() {
  Logger.log('=== Daily auto-clean started: ' + new Date().toISOString() + ' ===');
  purgeOldPromotions();
  bulkCleanup();
  Logger.log('=== Daily auto-clean complete ===');
}

/**
 * Run once to install a daily trigger at 3am.
 */
function installTrigger() {
  // Remove existing triggers first to avoid duplicates
  removeTriggers();

  ScriptApp.newTrigger('dailyAutoClean')
    .timeBased()
    .everyDays(1)
    .atHour(3)
    .create();

  Logger.log('Daily trigger installed. dailyAutoClean will run at ~3am every day.');
}

/**
 * Remove all triggers created by this script.
 */
function removeTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(trigger) {
    ScriptApp.deleteTrigger(trigger);
  });
  Logger.log('Removed ' + triggers.length + ' trigger(s).');
}

// ============================================================
// STEP 5: ADD YOUR BLOCK LIST
// ============================================================

/**
 * Example: after running discoverSpam(), add your unwanted domains here.
 * Customize this list for your inbox, then run once.
 *
 * Usage:
 *   1. Run discoverSpam() and review the logs
 *   2. Copy unwanted domains into the array below
 *   3. Run addBlocks()
 *   4. Run bulkCleanup() to trash existing emails
 */
function addBlocks() {
  updateBlockedDomains([
    // Add your domains here, e.g.:
    // 'spam-sender.com',
    // 'unwanted-newsletter.com',
  ]);
}
