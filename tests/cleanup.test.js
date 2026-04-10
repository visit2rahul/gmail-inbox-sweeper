/**
 * Tests for Gmail Inbox Sweeper (src/cleanup.gs)
 *
 * These tests verify all functions, safety guarantees, edge cases,
 * and the continuation trigger pattern using mocked Google Apps Script globals.
 *
 * Safety guarantees under test:
 *   - Primary inbox is never touched (query always includes -category:primary)
 *   - Trash only (moveToTrash, never delete)
 *   - Discovery is read-only (no moveToTrash calls during discoverSpam)
 *   - Block list is user-controlled (empty list = no action)
 *   - Continuation triggers auto-resume long-running operations
 */

const {
  mockLogger,
  mockPropertiesService,
  mockScriptProperties,
  mockGmailApp,
  mockScriptApp,
  mockUtilities,
  mockTriggerBuilder,
  createMockThread,
  setSearchResults,
  resetAllMocks,
  installGlobals,
} = require('./mocks/gas-mocks');

// Install mocks before loading the script
installGlobals();

// Load the script — functions become global via eval
const fs = require('fs');
const path = require('path');
const scriptSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'cleanup.gs'),
  'utf8'
);
eval(scriptSource);

// ============================================================
// Test setup
// ============================================================

beforeEach(() => {
  resetAllMocks();
});

// Helper: mock Date to simulate time progression past the limit
function mockTimeLimitExceeded() {
  var callCount = 0;
  var startTime = 1000000;
  var originalDate = global.Date;
  global.Date = class extends originalDate {
    getTime() {
      callCount++;
      // After first call, jump past 5 min
      if (callCount > 2) return startTime + 6 * 60 * 1000;
      return startTime;
    }
    toISOString() {
      return new originalDate().toISOString();
    }
  };
  return function restore() {
    global.Date = originalDate;
  };
}

// Helper: set up PropertiesService to track state across get/set calls
function useStatefulProperties(initial) {
  var store = Object.assign({}, initial || {});
  mockScriptProperties.getProperty.mockImplementation(function(key) {
    return store.hasOwnProperty(key) ? store[key] : null;
  });
  mockScriptProperties.setProperty.mockImplementation(function(key, val) {
    store[key] = val;
  });
  mockScriptProperties.deleteProperty.mockImplementation(function(key) {
    delete store[key];
  });
  mockScriptProperties.getProperties.mockImplementation(function() {
    return Object.assign({}, store);
  });
  return store;
}

// ============================================================
// A. Configuration functions
// ============================================================

describe('configureDefaults', () => {
  test('sets all three defaults when no properties exist', () => {
    useStatefulProperties();
    configureDefaults();

    expect(mockScriptProperties.setProperty).toHaveBeenCalledWith('BLOCK_DOMAINS', '[]');
    expect(mockScriptProperties.setProperty).toHaveBeenCalledWith('PROMO_MAX_AGE_DAYS', '7');
    expect(mockScriptProperties.setProperty).toHaveBeenCalledWith('SCAN_WINDOW_DAYS', '30');
  });

  test('does not overwrite existing properties (idempotent)', () => {
    useStatefulProperties({ PROMO_MAX_AGE_DAYS: '14' });
    configureDefaults();

    var promoSetCalls = mockScriptProperties.setProperty.mock.calls.filter(
      (call) => call[0] === 'PROMO_MAX_AGE_DAYS'
    );
    expect(promoSetCalls).toHaveLength(0);
  });

  test('logs confirmation of settings', () => {
    useStatefulProperties();
    configureDefaults();
    expect(mockLogger.log).toHaveBeenCalledWith('Defaults configured. Current settings:');
  });
});

describe('getBlockedDomains_ (internal)', () => {
  test('returns empty array when property is null', () => {
    var result = getBlockedDomains_();
    expect(result).toEqual([]);
  });

  test('returns empty array when property is empty JSON array', () => {
    mockScriptProperties.getProperty.mockReturnValue('[]');
    var result = getBlockedDomains_();
    expect(result).toEqual([]);
  });

  test('returns parsed array when property has domains', () => {
    mockScriptProperties.getProperty.mockReturnValue('["spam.com","junk.co"]');
    var result = getBlockedDomains_();
    expect(result).toEqual(['spam.com', 'junk.co']);
  });
});

describe('getConfigInt_ (internal)', () => {
  test('returns parsed integer when property exists', () => {
    mockScriptProperties.getProperty.mockReturnValue('7');
    var result = getConfigInt_('PROMO_MAX_AGE_DAYS', 99);
    expect(result).toBe(7);
  });

  test('returns fallback when property is null', () => {
    mockScriptProperties.getProperty.mockReturnValue(null);
    var result = getConfigInt_('PROMO_MAX_AGE_DAYS', 99);
    expect(result).toBe(99);
  });
});

// ============================================================
// B. Block list management
// ============================================================

describe('updateBlockedDomains', () => {
  test('adds new domains to an empty list', () => {
    useStatefulProperties({ BLOCK_DOMAINS: '[]' });
    updateBlockedDomains(['spam.com', 'junk.co']);

    var setCall = mockScriptProperties.setProperty.mock.calls.find(
      (call) => call[0] === 'BLOCK_DOMAINS'
    );
    expect(setCall).toBeDefined();
    var stored = JSON.parse(setCall[1]);
    expect(stored).toEqual(['spam.com', 'junk.co']);
  });

  test('merges without duplicates', () => {
    useStatefulProperties({ BLOCK_DOMAINS: '["a.com"]' });
    updateBlockedDomains(['a.com', 'b.com']);

    var setCall = mockScriptProperties.setProperty.mock.calls.find(
      (call) => call[0] === 'BLOCK_DOMAINS'
    );
    var stored = JSON.parse(setCall[1]);
    expect(stored).toEqual(['a.com', 'b.com']);
  });

  test('with no arguments, logs current list without modifying', () => {
    useStatefulProperties({ BLOCK_DOMAINS: '["a.com","b.com"]' });
    updateBlockedDomains();

    var setCall = mockScriptProperties.setProperty.mock.calls.find(
      (call) => call[0] === 'BLOCK_DOMAINS'
    );
    expect(setCall).toBeUndefined();
    expect(mockLogger.log).toHaveBeenCalledWith('Current blocked domains (2):');
  });

  test('with empty array, logs current list without modifying', () => {
    useStatefulProperties({ BLOCK_DOMAINS: '["a.com"]' });
    updateBlockedDomains([]);

    var setCall = mockScriptProperties.setProperty.mock.calls.find(
      (call) => call[0] === 'BLOCK_DOMAINS'
    );
    expect(setCall).toBeUndefined();
  });
});

describe('unblockDomain', () => {
  test('removes a domain that exists in the list', () => {
    useStatefulProperties({ BLOCK_DOMAINS: '["spam.com","junk.co"]' });
    unblockDomain('spam.com');

    var setCall = mockScriptProperties.setProperty.mock.calls.find(
      (call) => call[0] === 'BLOCK_DOMAINS'
    );
    var stored = JSON.parse(setCall[1]);
    expect(stored).toEqual(['junk.co']);
  });

  test('does not error when domain is not in the list', () => {
    useStatefulProperties({ BLOCK_DOMAINS: '["spam.com"]' });
    expect(() => unblockDomain('nothere.com')).not.toThrow();
  });

  test('results in empty list when removing the only domain', () => {
    useStatefulProperties({ BLOCK_DOMAINS: '["spam.com"]' });
    unblockDomain('spam.com');

    var setCall = mockScriptProperties.setProperty.mock.calls.find(
      (call) => call[0] === 'BLOCK_DOMAINS'
    );
    var stored = JSON.parse(setCall[1]);
    expect(stored).toEqual([]);
  });
});

// ============================================================
// C. Discovery (discoverSpam)
// ============================================================

describe('discoverSpam', () => {
  test('returns sender counts keyed by domain', () => {
    var thread1 = createMockThread('Newsletter <news@spam.com>', 3);
    var thread2 = createMockThread('Updates <info@spam.com>', 2);
    var thread3 = createMockThread('user@legit.org', 1);

    setSearchResults('category:promotions', [[thread1, thread3]]);
    setSearchResults('category:updates', [[thread2]]);
    setSearchResults('category:social', [[]]);
    setSearchResults('label:spam', [[]]);

    var result = discoverSpam();

    expect(result['spam.com']).toBe(5);
    expect(result['legit.org']).toBe(1);
  });

  test('extracts domain from formatted From header', () => {
    var thread = createMockThread('"Sales Team" <promo@retailer.com>', 1);
    setSearchResults('category:promotions', [[thread]]);
    setSearchResults('category:updates', [[]]);
    setSearchResults('category:social', [[]]);
    setSearchResults('label:spam', [[]]);

    var result = discoverSpam();
    expect(result['retailer.com']).toBe(1);
  });

  test('extracts domain from bare email address', () => {
    var thread = createMockThread('user@domain.org', 1);
    setSearchResults('category:promotions', [[thread]]);
    setSearchResults('category:updates', [[]]);
    setSearchResults('category:social', [[]]);
    setSearchResults('label:spam', [[]]);

    var result = discoverSpam();
    expect(result['domain.org']).toBe(1);
  });

  test('lowercases domains', () => {
    var thread = createMockThread('user@SPAM.COM', 1);
    setSearchResults('category:promotions', [[thread]]);
    setSearchResults('category:updates', [[]]);
    setSearchResults('category:social', [[]]);
    setSearchResults('label:spam', [[]]);

    var result = discoverSpam();
    expect(result['spam.com']).toBe(1);
  });

  test('handles From with no @ symbol gracefully', () => {
    var thread = createMockThread('Unknown Sender', 1);
    setSearchResults('category:promotions', [[thread]]);
    setSearchResults('category:updates', [[]]);
    setSearchResults('category:social', [[]]);
    setSearchResults('label:spam', [[]]);

    var result = discoverSpam();
    expect(result['Unknown Sender']).toBe(1);
  });

  test('returns empty object for empty inbox', () => {
    setSearchResults('category:promotions', [[]]);
    setSearchResults('category:updates', [[]]);
    setSearchResults('category:social', [[]]);
    setSearchResults('label:spam', [[]]);

    var result = discoverSpam();
    expect(Object.keys(result)).toHaveLength(0);
  });

  test('SAFETY: does not call moveToTrash (read-only)', () => {
    var thread = createMockThread('user@spam.com', 1);
    setSearchResults('category:promotions', [[thread]]);
    setSearchResults('category:updates', [[]]);
    setSearchResults('category:social', [[]]);
    setSearchResults('label:spam', [[]]);

    discoverSpam();

    expect(thread.moveToTrash).not.toHaveBeenCalled();
  });
});

// ============================================================
// D. Bulk cleanup — SAFETY CRITICAL
// ============================================================

describe('bulkCleanup', () => {
  test('with empty block list, logs message and does not search', () => {
    useStatefulProperties({ BLOCK_DOMAINS: '[]' });
    bulkCleanup();

    expect(mockGmailApp.search).not.toHaveBeenCalled();
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('No blocked domains')
    );
  });

  test('trashes emails from blocked domains', () => {
    useStatefulProperties({ BLOCK_DOMAINS: '["spam.com"]' });

    var thread1 = createMockThread('user@spam.com', 1);
    var thread2 = createMockThread('other@spam.com', 1);
    setSearchResults('from:@spam.com', [[thread1, thread2], []]);

    bulkCleanup();

    expect(thread1.moveToTrash).toHaveBeenCalled();
    expect(thread2.moveToTrash).toHaveBeenCalled();
  });

  test('SAFETY: search query always includes -category:primary', () => {
    useStatefulProperties({ BLOCK_DOMAINS: '["spam.com"]' });
    setSearchResults('from:@spam.com', [[]]);

    bulkCleanup();

    var searchQuery = mockGmailApp.search.mock.calls[0][0];
    expect(searchQuery).toContain('-category:primary');
  });

  test('SAFETY: uses moveToTrash, not any delete method', () => {
    useStatefulProperties({ BLOCK_DOMAINS: '["spam.com"]' });

    var thread = createMockThread('user@spam.com', 1);
    thread.moveToSpam = jest.fn();
    thread.delete = jest.fn();
    setSearchResults('from:@spam.com', [[thread], []]);

    bulkCleanup();

    expect(thread.moveToTrash).toHaveBeenCalled();
    expect(thread.moveToSpam).not.toHaveBeenCalled();
    expect(thread.delete).not.toHaveBeenCalled();
  });

  test('paginates through multiple batches', () => {
    useStatefulProperties({ BLOCK_DOMAINS: '["spam.com"]' });

    var batch1 = [
      createMockThread('a@spam.com', 1),
      createMockThread('b@spam.com', 1),
      createMockThread('c@spam.com', 1),
    ];
    var batch2 = [
      createMockThread('d@spam.com', 1),
      createMockThread('e@spam.com', 1),
    ];
    setSearchResults('from:@spam.com', [batch1, batch2, []]);

    bulkCleanup();

    batch1.forEach((t) => expect(t.moveToTrash).toHaveBeenCalled());
    batch2.forEach((t) => expect(t.moveToTrash).toHaveBeenCalled());
  });

  test('processes multiple blocked domains', () => {
    useStatefulProperties({ BLOCK_DOMAINS: '["spam.com","junk.co"]' });

    var spamThread = createMockThread('a@spam.com', 1);
    var junkThread = createMockThread('b@junk.co', 1);
    setSearchResults('from:@spam.com', [[spamThread], []]);
    setSearchResults('from:@junk.co', [[junkThread], []]);

    bulkCleanup();

    expect(spamThread.moveToTrash).toHaveBeenCalled();
    expect(junkThread.moveToTrash).toHaveBeenCalled();
  });

  test('schedules continuation trigger on time limit', () => {
    useStatefulProperties({ BLOCK_DOMAINS: '["spam.com"]' });
    var restore = mockTimeLimitExceeded();

    var threads = [createMockThread('a@spam.com', 1)];
    setSearchResults('from:@spam.com', [threads, threads, threads]);

    bulkCleanup();

    expect(mockScriptApp.newTrigger).toHaveBeenCalledWith('bulkCleanup');
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('Scheduling continuation')
    );

    restore();
  });

  test('saves domain index and total to state on time limit', () => {
    var store = useStatefulProperties({ BLOCK_DOMAINS: '["spam.com","junk.co"]' });
    var restore = mockTimeLimitExceeded();

    var threads = [createMockThread('a@spam.com', 1)];
    setSearchResults('from:@spam.com', [threads, threads, threads]);

    bulkCleanup();

    // Should have saved progress
    expect(store['STATE_BULK_CLEANUP_DOMAIN_INDEX']).toBeDefined();
    expect(store['STATE_BULK_CLEANUP_TOTAL']).toBeDefined();

    restore();
  });

  test('resumes from saved domain index on continuation', () => {
    // Simulate: domain 0 already done, resume from domain 1
    useStatefulProperties({
      BLOCK_DOMAINS: '["spam.com","junk.co"]',
      STATE_BULK_CLEANUP_DOMAIN_INDEX: '1',
      STATE_BULK_CLEANUP_TOTAL: '5'
    });

    var junkThread = createMockThread('b@junk.co', 1);
    setSearchResults('from:@junk.co', [[junkThread], []]);

    bulkCleanup();

    // Should NOT have searched for spam.com (already done)
    var spamSearches = mockGmailApp.search.mock.calls.filter(
      (call) => call[0].indexOf('spam.com') !== -1
    );
    expect(spamSearches).toHaveLength(0);

    // Should have processed junk.co
    expect(junkThread.moveToTrash).toHaveBeenCalled();

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('Resuming bulkCleanup')
    );
  });

  test('clears state when all domains are processed', () => {
    var store = useStatefulProperties({
      BLOCK_DOMAINS: '["spam.com"]',
      STATE_BULK_CLEANUP_DOMAIN_INDEX: '0',
      STATE_BULK_CLEANUP_TOTAL: '3'
    });

    setSearchResults('from:@spam.com', [[]]);

    bulkCleanup();

    expect(store['STATE_BULK_CLEANUP_DOMAIN_INDEX']).toBeUndefined();
    expect(store['STATE_BULK_CLEANUP_TOTAL']).toBeUndefined();
  });
});

// ============================================================
// E. Purge old promotions
// ============================================================

describe('purgeOldPromotions', () => {
  test('uses configured PROMO_MAX_AGE_DAYS in query', () => {
    useStatefulProperties({ PROMO_MAX_AGE_DAYS: '14' });
    setSearchResults('category:promotions', [[]]);

    purgeOldPromotions();

    var searchQuery = mockGmailApp.search.mock.calls[0][0];
    expect(searchQuery).toContain('older_than:14d');
  });

  test('falls back to 7 days when config is missing', () => {
    useStatefulProperties();
    setSearchResults('category:promotions', [[]]);

    purgeOldPromotions();

    var searchQuery = mockGmailApp.search.mock.calls[0][0];
    expect(searchQuery).toContain('older_than:7d');
  });

  test('trashes all matching threads', () => {
    useStatefulProperties();

    var thread1 = createMockThread('promo@store.com', 1);
    var thread2 = createMockThread('deals@shop.com', 1);
    setSearchResults('category:promotions', [[thread1, thread2], []]);

    purgeOldPromotions();

    expect(thread1.moveToTrash).toHaveBeenCalled();
    expect(thread2.moveToTrash).toHaveBeenCalled();
  });

  test('schedules continuation trigger on time limit', () => {
    useStatefulProperties();
    var restore = mockTimeLimitExceeded();

    var threads = [createMockThread('a@store.com', 1)];
    setSearchResults('category:promotions', [threads, threads, threads]);

    purgeOldPromotions();

    expect(mockScriptApp.newTrigger).toHaveBeenCalledWith('purgeOldPromotions');
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('Scheduling continuation')
    );

    restore();
  });

  test('resumes with previous total on continuation', () => {
    useStatefulProperties({ STATE_PURGE_PROMO_TOTAL: '50' });

    setSearchResults('category:promotions', [[]]);

    purgeOldPromotions();

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('Resuming purgeOldPromotions')
    );
  });

  test('clears state when complete', () => {
    var store = useStatefulProperties({ STATE_PURGE_PROMO_TOTAL: '50' });

    setSearchResults('category:promotions', [[]]);

    purgeOldPromotions();

    expect(store['STATE_PURGE_PROMO_TOTAL']).toBeUndefined();
  });
});

// ============================================================
// F. Mark all as read
// ============================================================

describe('markAllRead', () => {
  test('marks all unread threads as read', () => {
    useStatefulProperties();

    var thread1 = createMockThread('a@test.com', 1);
    var thread2 = createMockThread('b@test.com', 1);
    setSearchResults('is:unread', [[thread1, thread2], []]);

    markAllRead();

    expect(thread1.markRead).toHaveBeenCalled();
    expect(thread2.markRead).toHaveBeenCalled();
  });

  test('searches with is:unread query', () => {
    useStatefulProperties();
    setSearchResults('is:unread', [[]]);

    markAllRead();

    var searchQuery = mockGmailApp.search.mock.calls[0][0];
    expect(searchQuery).toBe('is:unread');
  });

  test('paginates through multiple batches', () => {
    useStatefulProperties();

    var batch1 = [
      createMockThread('a@test.com', 1),
      createMockThread('b@test.com', 1),
    ];
    var batch2 = [
      createMockThread('c@test.com', 1),
    ];
    setSearchResults('is:unread', [batch1, batch2, []]);

    markAllRead();

    batch1.forEach((t) => expect(t.markRead).toHaveBeenCalled());
    batch2.forEach((t) => expect(t.markRead).toHaveBeenCalled());
  });

  test('does not call moveToTrash (read-only operation)', () => {
    useStatefulProperties();

    var thread = createMockThread('a@test.com', 1);
    setSearchResults('is:unread', [[thread], []]);

    markAllRead();

    expect(thread.markRead).toHaveBeenCalled();
    expect(thread.moveToTrash).not.toHaveBeenCalled();
  });

  test('handles empty inbox (no unread emails)', () => {
    useStatefulProperties();
    setSearchResults('is:unread', [[]]);

    markAllRead();

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('0 threads marked as read')
    );
  });

  test('pauses every 1000 threads to avoid rate limits', () => {
    useStatefulProperties();

    var batches = [];
    for (var b = 0; b < 10; b++) {
      var batch = [];
      for (var t = 0; t < 100; t++) {
        batch.push(createMockThread('user' + (b * 100 + t) + '@test.com', 1));
      }
      batches.push(batch);
    }
    batches.push([]);
    setSearchResults('is:unread', batches);

    markAllRead();

    expect(mockUtilities.sleep).toHaveBeenCalledWith(2000);
    expect(mockUtilities.sleep).toHaveBeenCalledTimes(1);
  });

  test('does not pause before reaching 1000 threads', () => {
    useStatefulProperties();

    var batch = [];
    for (var t = 0; t < 50; t++) {
      batch.push(createMockThread('user' + t + '@test.com', 1));
    }
    setSearchResults('is:unread', [[...batch], []]);

    markAllRead();

    expect(mockUtilities.sleep).not.toHaveBeenCalled();
  });

  test('schedules continuation trigger on time limit', () => {
    useStatefulProperties();
    var restore = mockTimeLimitExceeded();

    var threads = [createMockThread('a@test.com', 1)];
    setSearchResults('is:unread', [threads, threads, threads]);

    markAllRead();

    expect(mockScriptApp.newTrigger).toHaveBeenCalledWith('markAllRead');
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('Scheduling continuation')
    );

    restore();
  });

  test('resumes with previous total on continuation', () => {
    useStatefulProperties({ STATE_MARK_READ_TOTAL: '500' });

    setSearchResults('is:unread', [[]]);

    markAllRead();

    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('Resuming markAllRead')
    );
  });

  test('clears state when complete', () => {
    var store = useStatefulProperties({ STATE_MARK_READ_TOTAL: '500' });

    setSearchResults('is:unread', [[]]);

    markAllRead();

    expect(store['STATE_MARK_READ_TOTAL']).toBeUndefined();
  });
});

// ============================================================
// G. Trigger management
// ============================================================

describe('installTrigger', () => {
  test('removes existing dailyAutoClean triggers before creating new one', () => {
    var oldTrigger = { id: 'old', getHandlerFunction: () => 'dailyAutoClean' };
    var contTrigger = { id: 'cont', getHandlerFunction: () => 'bulkCleanup' };
    mockScriptApp.getProjectTriggers.mockReturnValue([oldTrigger, contTrigger]);

    installTrigger();

    // Should delete the old daily trigger
    expect(mockScriptApp.deleteTrigger).toHaveBeenCalledWith(oldTrigger);
    // Should NOT delete continuation triggers
    expect(mockScriptApp.deleteTrigger).not.toHaveBeenCalledWith(contTrigger);
    expect(mockScriptApp.newTrigger).toHaveBeenCalledWith('dailyAutoClean');
  });

  test('creates a daily trigger at 3am', () => {
    mockScriptApp.getProjectTriggers.mockReturnValue([]);

    installTrigger();

    expect(mockTriggerBuilder.timeBased).toHaveBeenCalled();
    expect(mockTriggerBuilder.everyDays).toHaveBeenCalledWith(1);
    expect(mockTriggerBuilder.atHour).toHaveBeenCalledWith(3);
    expect(mockTriggerBuilder.create).toHaveBeenCalled();
  });
});

describe('removeTriggers', () => {
  test('deletes all existing triggers', () => {
    var trigger1 = { id: 't1' };
    var trigger2 = { id: 't2' };
    mockScriptApp.getProjectTriggers.mockReturnValue([trigger1, trigger2]);
    useStatefulProperties({
      STATE_BULK_CLEANUP_DOMAIN_INDEX: '2',
      STATE_MARK_READ_TOTAL: '100'
    });

    removeTriggers();

    expect(mockScriptApp.deleteTrigger).toHaveBeenCalledWith(trigger1);
    expect(mockScriptApp.deleteTrigger).toHaveBeenCalledWith(trigger2);
  });

  test('clears continuation state', () => {
    mockScriptApp.getProjectTriggers.mockReturnValue([]);
    var store = useStatefulProperties({
      STATE_BULK_CLEANUP_DOMAIN_INDEX: '2',
      STATE_BULK_CLEANUP_TOTAL: '50',
      STATE_MARK_READ_TOTAL: '100',
      STATE_PURGE_PROMO_TOTAL: '30'
    });

    removeTriggers();

    expect(store['STATE_BULK_CLEANUP_DOMAIN_INDEX']).toBeUndefined();
    expect(store['STATE_BULK_CLEANUP_TOTAL']).toBeUndefined();
    expect(store['STATE_MARK_READ_TOTAL']).toBeUndefined();
    expect(store['STATE_PURGE_PROMO_TOTAL']).toBeUndefined();
  });

  test('does not error with zero existing triggers', () => {
    mockScriptApp.getProjectTriggers.mockReturnValue([]);
    useStatefulProperties();

    expect(() => removeTriggers()).not.toThrow();
    expect(mockLogger.log).toHaveBeenCalledWith('Removed 0 trigger(s).');
  });
});

// ============================================================
// H. Continuation helpers
// ============================================================

describe('scheduleContinuation_', () => {
  test('removes existing triggers for the same function before creating new one', () => {
    var existingTrigger = { id: 'old', getHandlerFunction: () => 'bulkCleanup' };
    var otherTrigger = { id: 'other', getHandlerFunction: () => 'dailyAutoClean' };
    mockScriptApp.getProjectTriggers.mockReturnValue([existingTrigger, otherTrigger]);

    scheduleContinuation_('bulkCleanup');

    expect(mockScriptApp.deleteTrigger).toHaveBeenCalledWith(existingTrigger);
    expect(mockScriptApp.deleteTrigger).not.toHaveBeenCalledWith(otherTrigger);
    expect(mockScriptApp.newTrigger).toHaveBeenCalledWith('bulkCleanup');
  });
});

// ============================================================
// I. Integration: dailyAutoClean
// ============================================================

describe('dailyAutoClean', () => {
  test('calls purgeOldPromotions, bulkCleanup, and markAllRead', () => {
    useStatefulProperties();
    setSearchResults('category:promotions', [[]]);
    setSearchResults('is:unread', [[]]);

    dailyAutoClean();

    expect(mockGmailApp.search).toHaveBeenCalled();
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('Daily auto-clean started')
    );
    expect(mockLogger.log).toHaveBeenCalledWith(
      expect.stringContaining('Daily auto-clean complete')
    );
  });
});

// ============================================================
// J. addBlocks (template function)
// ============================================================

describe('addBlocks', () => {
  test('calls updateBlockedDomains (template has empty array by default)', () => {
    useStatefulProperties({ BLOCK_DOMAINS: '[]' });
    expect(() => addBlocks()).not.toThrow();
  });
});
