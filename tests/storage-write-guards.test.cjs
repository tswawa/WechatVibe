const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const path = require('node:path');

const source = readFileSync(path.join(__dirname, '..', 'chatui', 'app.js'), 'utf8');

function slice(startAnchor, endAnchor) {
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start);
  assert.ok(start >= 0 && end > start, `cannot slice ${startAnchor}`);
  return source.slice(start, end);
}

const followSource = slice('const conversationFollowKey =', 'async function trackNewConversations(');
const saveStart = source.indexOf('const save = () =>');
const saveSource = source.slice(saveStart, source.indexOf('\n', saveStart));

/** localStorage whose every operation fails, the way a full or blocked partition behaves. */
function blockedStorage() {
  const fail = () => { throw new Error('storage blocked'); };
  return { length: 0, key: fail, getItem: fail, setItem: fail, removeItem: fail };
}

/**
 * A storage that still reads but refuses to write. Reading has to work for the follow-list writers
 * to reach their write at all, which is what makes the guard observable.
 */
function writeBlockedStorage(entries) {
  return {
    get length() { return entries.size; },
    key: index => [...entries.keys()][index] ?? null,
    getItem: key => (entries.has(key) ? entries.get(key) : null),
    setItem: () => { throw new Error('storage blocked'); },
    removeItem: () => { throw new Error('storage blocked'); },
  };
}

test('a failing settings write does not escape the handler that flipped the switch', () => {
  const context = vm.createContext({ localStorage: blockedStorage(), settingsState: { settings: {} } });
  vm.runInContext(`${saveSource}\nglobalThis.save = save;`, context);
  assert.doesNotThrow(() => context.save());
});

test('a failing follow-list write does not turn a session load into a WeChat failure', () => {
  const entries = new Map();
  const context = vm.createContext({ localStorage: writeBlockedStorage(entries) });
  vm.runInContext(`${followSource}\nglobalThis.remember = rememberConversations;` +
    '\nglobalThis.forget = forgetConversationFollow;\nglobalThis.followKey = conversationFollowKey;',
    context);
  assert.doesNotThrow(() => context.remember('account-a', ['conversation-1']));
  entries.set(context.followKey, JSON.stringify({ 'account-a': { known: ['conversation-1'] } }));
  assert.doesNotThrow(() => context.forget('account-a'));
});

test('the mbti cleanup loop is guarded as well (source-level check)', () => {
  // That loop lives inside the account-clearing function, whose other dependencies make a sliced
  // runtime harness impractical, so this pins the shape rather than the behaviour.
  assert.match(source, /try \{\s*\n\s*for \(let index = localStorage\.length - 1; index >= 0; index--\) \{/u);
});
