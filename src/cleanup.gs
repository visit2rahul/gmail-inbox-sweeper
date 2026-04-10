/**
 * Gmail Inbox Sweeper — Google Apps Script
 *
 * Automatically discovers spam senders in your inbox, lets you block them
 * by domain, and schedules daily cleanup. Never touches your Primary inbox.
 * Everything goes to Trash (recoverable for 30 days).
 *
 * Long-running operations automatically continue via triggers — no need
 * to manually re-run. The script saves progress, schedules a continuation
 * trigger, and resumes where it left off.
 *
 * Quick start:
 *   1. Run configureDefaults()    — one-time setup
 *   2. Run discoverSpam()         — see who's spamming you (read-only, changes nothing)
 *   3. Run addBlocks()            — add unwanted domains (edit the function first)
 *   4. Run bulkCleanup()          — trash emails from blocked domains
 *   5. Run installTrigger()       — schedule daily auto-cleanup at 3am
 *
 * All functions:
 *   configureDefaults()     — Initialize script settings (run once).
 *   discoverSpam()          — Read-only scan. Ranks top senders across Promotions,
 *                             Updates, Social, and Spam from the last 30 days.
 *   addBlocks()             — Add domains to your block list. Edit this function
 *                             with domains from discoverSpam(), then run once.
 *   updateBlockedDomains()  — Programmatically add domains to the block list.
 *   unblockDomain()         — Remove a domain from the block list.
 *   bulkCleanup()           — Trash all emails from blocked domains (skips Primary).
 *                             Auto-continues via trigger if it hits the time limit.
 *   purgeOldPromotions()    — Trash promotions older than 7 days (configurable).
 *                             Auto-continues via trigger if it hits the time limit.
 *   markAllRead()           — Mark all unread emails as read.
 *                             Auto-continues via trigger if it hits the time limit.
 *   dailyAutoClean()        — Runs bulkCleanup + purgeOldPromotions + markAllRead.
 *   installTrigger()        — Set up daily auto-cleanup trigger at 3am.
 *   removeTriggers()        — Remove all scheduled triggers.
 *
 * Configuration is stored in Script Properties (not hardcoded).
 * Your block list persists across script updates.
 */

// ============================================================
// CONFIGURATION — stored in Script Properties
// ============================================================

var CONFIG_KEYS = {
  BLOCK_DOMAINS: 'BLOCK_DOMAINS',
  PROMO_MAX_AGE_DAYS: 'PROMO_MAX_AGE_DAYS',
  SCAN_WINDOW_DAYS: 'SCAN_WINDOW_DAYS'
};

// Keys used for continuation state
var STATE_KEYS = {
  BULK_CLEANUP_DOMAIN_INDEX: 'STATE_BULK_CLEANUP_DOMAIN_INDEX',
  BULK_CLEANUP_TOTAL: 'STATE_BULK_CLEANUP_TOTAL',
  MARK_READ_TOTAL: 'STATE_MARK_READ_TOTAL',
  PURGE_PROMO_TOTAL: 'STATE_PURGE_PROMO_TOTAL'
};

// How long to wait before the continuation trigger fires (in minutes)
var CONTINUATION_DELAY_MINUTES = 1;

// Time limit safety margin (5 minutes out of 6 max)
var TIME_LIMIT_MS = 5 * 60 * 1000;

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
    // Don't log internal state keys
    if (key.indexOf('STATE_') !== 0) {
      Logger.log('  ' + key + ' = ' + props[key]);
    }
  });
}

// ============================================================
// CONTINUATION HELPERS
// ============================================================

/**
 * Schedule a one-time trigger to call the given function after a delay.
 * Removes any existing continuation triggers for the same function first.
 */
function scheduleContinuation_(functionName) {
  // Remove existing continuation triggers for this function
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === functionName) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger(functionName)
    .timeBased()
    .after(CONTINUATION_DELAY_MINUTES * 60 * 1000)
    .create();

  Logger.log('Scheduled ' + functionName + ' to resume in ' + CONTINUATION_DELAY_MINUTES + ' minute(s).');
}

/**
 * Clean up continuation state for a given prefix.
 */
function clearState_(keys) {
  var props = PropertiesService.getScriptProperties();
  for (var i = 0; i < keys.length; i++) {
    props.deleteProperty(keys[i]);
  }
}

/**
 * Check if we're approaching the execution time limit.
 */
function isApproachingTimeLimit_(startTime) {
  return new Date().getTime() - startTime > TIME_LIMIT_MS;
}

// ============================================================
// BLOCK LIST MANAGEMENT
// ============================================================

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

/**
 * Trashes all emails from blocked domains (skips Primary).
 * Saves progress and auto-continues via trigger if it hits the time limit.
 */
function bulkCleanup() {
  var props = PropertiesService.getScriptProperties();
  var domains = getBlockedDomains_();
  if (domains.length === 0) {
    Logger.log('No blocked domains configured. Run discoverSpam() first, then updateBlockedDomains([...]).');
    return;
  }

  // Restore state from previous run (if continuing)
  var startIndex = parseInt(props.getProperty(STATE_KEYS.BULK_CLEANUP_DOMAIN_INDEX) || '0', 10);
  var totalTrashed = parseInt(props.getProperty(STATE_KEYS.BULK_CLEANUP_TOTAL) || '0', 10);

  if (startIndex > 0) {
    Logger.log('Resuming bulkCleanup from domain ' + (startIndex + 1) + ' of ' + domains.length +
               ' (' + totalTrashed + ' trashed so far).');
  }

  var startTime = new Date().getTime();

  for (var i = startIndex; i < domains.length; i++) {
    var domain = domains[i];
    // Safety: explicitly exclude Primary to never touch important emails
    var query = 'from:@' + domain + ' -category:primary';
    var threads = GmailApp.search(query, 0, 100);
    var count = 0;

    while (threads.length > 0) {
      for (var j = 0; j < threads.length; j++) {
        threads[j].moveToTrash();
        count++;
      }

      if (isApproachingTimeLimit_(startTime)) {
        totalTrashed += count;
        Logger.log('Trashed ' + count + ' threads from ' + domain);
        Logger.log('Time limit approaching (' + totalTrashed + ' total trashed). Scheduling continuation...');

        // Save progress
        props.setProperty(STATE_KEYS.BULK_CLEANUP_DOMAIN_INDEX, String(i + 1));
        props.setProperty(STATE_KEYS.BULK_CLEANUP_TOTAL, String(totalTrashed));
        scheduleContinuation_('bulkCleanup');
        return;
      }

      threads = GmailApp.search(query, 0, 100);
    }

    totalTrashed += count;
    if (count > 0) {
      Logger.log('Trashed ' + count + ' threads from ' + domain);
    }
  }

  // All done — clean up state
  clearState_([STATE_KEYS.BULK_CLEANUP_DOMAIN_INDEX, STATE_KEYS.BULK_CLEANUP_TOTAL]);
  Logger.log('\nBulk cleanup complete. Total trashed: ' + totalTrashed + ' threads.');
}

// ============================================================
// STEP 3: PURGE OLD PROMOTIONS
// ============================================================

/**
 * Trashes promotional emails older than configured threshold.
 * Auto-continues via trigger if it hits the time limit.
 */
function purgeOldPromotions() {
  var props = PropertiesService.getScriptProperties();
  var maxAgeDays = getConfigInt_(CONFIG_KEYS.PROMO_MAX_AGE_DAYS, 7);
  var startTime = new Date().getTime();

  // Restore state from previous run
  var totalTrashed = parseInt(props.getProperty(STATE_KEYS.PURGE_PROMO_TOTAL) || '0', 10);

  if (totalTrashed > 0) {
    Logger.log('Resuming purgeOldPromotions (' + totalTrashed + ' trashed so far).');
  }

  var query = 'category:promotions older_than:' + maxAgeDays + 'd';
  var threads = GmailApp.search(query, 0, 100);
  var count = 0;

  while (threads.length > 0) {
    for (var i = 0; i < threads.length; i++) {
      threads[i].moveToTrash();
      count++;
    }

    if (isApproachingTimeLimit_(startTime)) {
      totalTrashed += count;
      Logger.log('Time limit approaching (' + totalTrashed + ' total trashed). Scheduling continuation...');
      props.setProperty(STATE_KEYS.PURGE_PROMO_TOTAL, String(totalTrashed));
      scheduleContinuation_('purgeOldPromotions');
      return;
    }

    threads = GmailApp.search(query, 0, 100);
  }

  totalTrashed += count;
  clearState_([STATE_KEYS.PURGE_PROMO_TOTAL]);
  Logger.log('Purge complete. Trashed ' + totalTrashed + ' promotional threads older than ' + maxAgeDays + ' days.');
}

// ============================================================
// STEP 4: MARK ALL AS READ
// ============================================================

/**
 * Marks all unread emails as read across your entire inbox.
 * Processes in batches of 100, pauses every 1000 threads to avoid rate limits.
 * Auto-continues via trigger if it hits the time limit.
 */
function markAllRead() {
  var props = PropertiesService.getScriptProperties();
  var startTime = new Date().getTime();
  var query = 'is:unread';
  var threads = GmailApp.search(query, 0, 100);
  var BATCH_PAUSE_THRESHOLD = 1000;
  var PAUSE_MS = 2000;

  // Restore state from previous run
  var totalMarked = parseInt(props.getProperty(STATE_KEYS.MARK_READ_TOTAL) || '0', 10);
  var count = 0;

  if (totalMarked > 0) {
    Logger.log('Resuming markAllRead (' + totalMarked + ' marked so far).');
  }

  while (threads.length > 0) {
    for (var i = 0; i < threads.length; i++) {
      threads[i].markRead();
      count++;
    }

    var runningTotal = totalMarked + count;

    // Pause every 1000 threads to avoid rate limits
    if (runningTotal % BATCH_PAUSE_THRESHOLD === 0 && runningTotal > 0) {
      Logger.log('Processed ' + runningTotal + ' threads. Pausing ' + (PAUSE_MS / 1000) + 's to avoid rate limits...');
      Utilities.sleep(PAUSE_MS);
    }

    if (isApproachingTimeLimit_(startTime)) {
      Logger.log('Time limit approaching (' + runningTotal + ' threads marked read). Scheduling continuation...');
      props.setProperty(STATE_KEYS.MARK_READ_TOTAL, String(runningTotal));
      scheduleContinuation_('markAllRead');
      return;
    }

    threads = GmailApp.search(query, 0, 100);
  }

  totalMarked += count;
  clearState_([STATE_KEYS.MARK_READ_TOTAL]);
  Logger.log('Mark all read complete. Total: ' + totalMarked + ' threads marked as read.');
}

// ============================================================
// STEP 5: SCHEDULED AUTO-CLEANUP
// ============================================================

function dailyAutoClean() {
  Logger.log('=== Daily auto-clean started: ' + new Date().toISOString() + ' ===');
  purgeOldPromotions();
  bulkCleanup();
  markAllRead();
  Logger.log('=== Daily auto-clean complete ===');
}

/**
 * Run once to install a daily trigger at 3am.
 */
function installTrigger() {
  // Remove existing daily trigger (keep continuation triggers)
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'dailyAutoClean') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger('dailyAutoClean')
    .timeBased()
    .everyDays(1)
    .atHour(3)
    .create();

  Logger.log('Daily trigger installed. dailyAutoClean will run at ~3am every day.');
}

/**
 * Remove all triggers created by this script (daily + continuation).
 */
function removeTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    ScriptApp.deleteTrigger(triggers[i]);
  }
  Logger.log('Removed ' + triggers.length + ' trigger(s).');

  // Also clear any saved continuation state
  clearState_([
    STATE_KEYS.BULK_CLEANUP_DOMAIN_INDEX,
    STATE_KEYS.BULK_CLEANUP_TOTAL,
    STATE_KEYS.MARK_READ_TOTAL,
    STATE_KEYS.PURGE_PROMO_TOTAL
  ]);
  Logger.log('Cleared continuation state.');
}

// ============================================================
// STEP 6: ADD YOUR BLOCK LIST
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
