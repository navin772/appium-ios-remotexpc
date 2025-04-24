/**
 * This file is used to run all integration tests
 * It imports all the test files to ensure they are included in the test run
 */
// Import all test files
import './integration/diagnostics-test.js';
import './integration/read-pair-record-test.js';
import './integration/tunnel-test.js';

// This file doesn't need to do anything else, as Mocha will automatically
// discover and run the tests from the imported files
