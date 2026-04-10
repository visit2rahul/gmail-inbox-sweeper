/**
 * Mock implementations of Google Apps Script global objects.
 *
 * Mocks: GmailApp, PropertiesService, ScriptApp, Logger
 *
 * Each mock is designed to be reset between tests via resetAllMocks().
 * GmailApp.search behavior is configurable per test via setSearchResults().
 */

// ============================================================
// Logger mock
// ============================================================

const mockLogger = {
  log: jest.fn(),
};

// ============================================================
// PropertiesService mock
// ============================================================

let propertiesStore = {};

const mockScriptProperties = {
  getProperty: jest.fn((key) => {
    return propertiesStore.hasOwnProperty(key) ? propertiesStore[key] : null;
  }),
  setProperty: jest.fn((key, value) => {
    propertiesStore[key] = value;
  }),
  getProperties: jest.fn(() => {
    return { ...propertiesStore };
  }),
  deleteProperty: jest.fn((key) => {
    delete propertiesStore[key];
  }),
};

const mockPropertiesService = {
  getScriptProperties: jest.fn(() => mockScriptProperties),
};

// ============================================================
// GmailApp mock
// ============================================================

// Configurable search results: map of query pattern -> array of thread batches
// Each batch is returned on successive calls to search with the same query.
let searchResultsMap = {};
let searchCallCounts = {};

function createMockMessage(from) {
  return {
    getFrom: jest.fn(() => from),
  };
}

function createMockThread(from, messageCount) {
  messageCount = messageCount || 1;
  var messages = [];
  for (var i = 0; i < messageCount; i++) {
    messages.push(createMockMessage(from));
  }
  return {
    getMessages: jest.fn(() => messages),
    getMessageCount: jest.fn(() => messageCount),
    moveToTrash: jest.fn(),
    markRead: jest.fn(),
  };
}

const mockGmailApp = {
  search: jest.fn((query, start, max) => {
    // Find matching result set by checking if the query contains any registered key
    var matchKey = null;
    Object.keys(searchResultsMap).forEach(function (key) {
      if (query.indexOf(key) !== -1 || key === query) {
        matchKey = key;
      }
    });

    if (!matchKey) return [];

    if (!searchCallCounts[matchKey]) searchCallCounts[matchKey] = 0;
    var batches = searchResultsMap[matchKey];
    var batchIndex = searchCallCounts[matchKey];
    searchCallCounts[matchKey]++;

    if (batchIndex < batches.length) {
      return batches[batchIndex];
    }
    return [];
  }),
};

/**
 * Configure search results for a given query pattern.
 * @param {string} queryPattern - A string that the query must contain to match.
 * @param {Array<Array>} batches - Array of arrays of mock threads.
 *   Each inner array is returned on successive calls.
 *   Example: [[thread1, thread2], [thread3], []] means:
 *     - First call returns [thread1, thread2]
 *     - Second call returns [thread3]
 *     - Third call returns [] (signals end)
 */
function setSearchResults(queryPattern, batches) {
  searchResultsMap[queryPattern] = batches;
  searchCallCounts[queryPattern] = 0;
}

// ============================================================
// ScriptApp mock
// ============================================================

let projectTriggers = [];

const mockTriggerBuilder = {
  timeBased: jest.fn(function () { return this; }),
  everyDays: jest.fn(function () { return this; }),
  atHour: jest.fn(function () { return this; }),
  after: jest.fn(function () { return this; }),
  create: jest.fn(function () {
    var trigger = { id: 'trigger_' + Date.now() };
    projectTriggers.push(trigger);
    return trigger;
  }),
};

const mockScriptApp = {
  newTrigger: jest.fn(() => mockTriggerBuilder),
  getProjectTriggers: jest.fn(() => [...projectTriggers]),
  deleteTrigger: jest.fn((trigger) => {
    projectTriggers = projectTriggers.filter(function (t) { return t !== trigger; });
  }),
};

// ============================================================
// Utilities mock
// ============================================================

const mockUtilities = {
  sleep: jest.fn(),
};

// ============================================================
// Reset function — call in beforeEach
// ============================================================

function resetAllMocks() {
  // Clear Jest mocks
  mockLogger.log.mockClear();
  mockScriptProperties.getProperty.mockClear();
  mockScriptProperties.setProperty.mockClear();
  mockScriptProperties.getProperties.mockClear();
  mockScriptProperties.deleteProperty.mockClear();
  mockPropertiesService.getScriptProperties.mockClear();
  mockGmailApp.search.mockClear();
  mockScriptApp.newTrigger.mockClear();
  mockScriptApp.getProjectTriggers.mockClear();
  mockScriptApp.deleteTrigger.mockClear();
  mockUtilities.sleep.mockClear();
  mockTriggerBuilder.timeBased.mockClear();
  mockTriggerBuilder.after.mockClear();
  mockTriggerBuilder.everyDays.mockClear();
  mockTriggerBuilder.atHour.mockClear();
  mockTriggerBuilder.create.mockClear();

  // Reset state
  propertiesStore = {};
  searchResultsMap = {};
  searchCallCounts = {};
  projectTriggers = [];
}

// ============================================================
// Install mocks as globals
// ============================================================

function installGlobals() {
  global.GmailApp = mockGmailApp;
  global.PropertiesService = mockPropertiesService;
  global.ScriptApp = mockScriptApp;
  global.Logger = mockLogger;
  global.Utilities = mockUtilities;
}

module.exports = {
  mockLogger,
  mockPropertiesService,
  mockScriptProperties,
  mockGmailApp,
  mockScriptApp,
  mockUtilities,
  mockTriggerBuilder,
  createMockThread,
  createMockMessage,
  setSearchResults,
  resetAllMocks,
  installGlobals,
  // Expose for direct manipulation in tests
  get propertiesStore() { return propertiesStore; },
  set propertiesStore(val) { propertiesStore = val; },
};
