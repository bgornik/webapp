/**
 * Shared state for the tea picker at https://bgornik.github.io/webapp/
 *
 * This runs in Google Apps Script, not on the site. Deployed as a web app ("Execute as: Me",
 * "Who has access: Anyone"), it gives the page one address to call:
 *   GET   returns the saved state as JSON
 *   POST  replaces the saved state with the JSON sent as the request body
 * The state is kept in one file in the deploying account's Google Drive, named below.
 * README.md has the deployment steps.
 */
const FILE_NAME = 'izbirnik-caja.json';
const MAX_LENGTH = 50000; // characters; far more than the app ever sends

function doGet() {
  return reply(stateFile().getBlob().getDataAsString());
}

function doPost(e) {
  const body = e && e.postData ? e.postData.contents : '';
  if (body.length > MAX_LENGTH) return reply(JSON.stringify({ error: 'too large' }));
  let state;
  try {
    state = JSON.parse(body);
  } catch (err) {
    return reply(JSON.stringify({ error: 'not JSON' }));
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return reply(JSON.stringify({ error: 'not an object' }));
  }

  // One writer at a time, so two saves arriving together cannot leave a half-written file.
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    stateFile().setContent(JSON.stringify(state));
  } finally {
    lock.releaseLock();
  }
  return reply(JSON.stringify(state));
}

// The file is looked up by name once; after that its id is remembered, which is much quicker.
function stateFile() {
  const properties = PropertiesService.getScriptProperties();
  const id = properties.getProperty('fileId');
  if (id) {
    try {
      const known = DriveApp.getFileById(id);
      if (!known.isTrashed()) return known;
    } catch (err) {
      // The file was deleted: fall through and make a new one.
    }
  }
  const found = DriveApp.getFilesByName(FILE_NAME);
  const file = found.hasNext() ? found.next() : DriveApp.createFile(FILE_NAME, '{}', 'application/json');
  properties.setProperty('fileId', file.getId());
  return file;
}

function reply(text) {
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}
