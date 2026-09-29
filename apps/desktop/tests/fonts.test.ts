import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FontLibrary, validateFont } from '../src/main/font-library';
import { StateStore } from '../src/main/store';
import { settingsSchema } from '../src/shared/schema';
import { DEFAULT_TYPOGRAPHY, MAX_FONT_BYTES, MAX_IMPORTED_FONTS, SYSTEM_FONT_STACK, fontFamily, importedFamily, isFontId, normalizeSystemFonts, systemFontFamily, systemFontId, typography } from '../src/shared/fonts';
import { fontFixture } from './fixtures/font';

const oldSettings = { claudePath: '', shellPath: '', maxSessions: 4, fontSize: 16, scrollback: 8000 };

test('fonts: system families deduplicate styles and encode names without allowing CSS or malformed IDs', () => {
  const fonts = normalizeSystemFonts([{family:'Arial'},{family:'Arial'},{family:'arial'},{family:' 微软雅黑 '},{family:''},{family:'bad\nfont'},{family:12},{family:'\ud800'}]);
  assert.equal(fonts.length, 2);
  for (const font of fonts) { assert.equal(systemFontFamily(font.id),font.name); assert.ok(isFontId(font.id)); }
  const name = '字体 "Quoted", serif; \\ font';
  assert.equal(systemFontFamily(systemFontId(name)), name);
  assert.equal(fontFamily(systemFontId(name)), '"字体 \\"Quoted\\", serif; \\\\ font", ' + SYSTEM_FONT_STACK);
  for (const id of ['system:','system:%ZZ','system:%0AArial','system:Arial%20','system:%41rial','system:'+'x'.repeat(257),'system:%ED%A0%80']) assert.equal(isFontId(id), false, id);
  assert.equal(fontFamily('system:%ZZ' as never),SYSTEM_FONT_STACK);
});

test('fonts: explicit system families and independent sizes survive saving and restarting', () => {
  const f = fixture();
  try {
    const store = new StateStore(f.data), chat = systemFontId('Microsoft YaHei'), ui = systemFontId('Segoe UI');
    store.change(state => {Object.assign(state.settings,{chatFontFamily:chat,uiFontFamily:ui,chatFontSize:19,uiFontSize:15});});
    const restored = new StateStore(f.data).state.settings;
    assert.deepEqual(typography(restored),{chatFontFamily:chat,uiFontFamily:ui,chatFontSize:19,uiFontSize:15});
    assert.equal(restored.fontSize,14);
    assert.ok(settingsSchema.safeParse(restored).success);
  } finally { f.dispose(); }
});
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-desk-fonts-unit-'));
  const source = path.join(directory, '我的字体.woff2'), data = path.join(directory, 'data');
  fs.writeFileSync(source, fontFixture);
  return { directory, source, data, library: new FontLibrary(data), dispose: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test('fonts: old workspaces keep their terminal size and receive independent chat and menu defaults', () => {
  const f = fixture();
  try {
    fs.mkdirSync(f.data);
    fs.writeFileSync(path.join(f.data, 'workspace.json'), JSON.stringify({version:1,projects:[],sessions:[],settings:oldSettings}));
    const store = new StateStore(f.data);
    assert.deepEqual(typography(store.state.settings), DEFAULT_TYPOGRAPHY);
    assert.equal(store.state.settings.fontSize, 16);
    const font = f.library.importFile(f.source);
    store.change(state => {state.settings.chatFontSize=22;state.settings.uiFontFamily=font.id;state.settings.uiFontSize=17;});
    const restored = new StateStore(f.data).state.settings;
    assert.equal(restored.chatFontSize, 22); assert.equal(restored.uiFontSize, 17);
    assert.equal(restored.uiFontFamily, font.id); assert.equal(restored.fontSize, 16);
  } finally { f.dispose(); }
});

test('fonts: settings reject unknown families, CSS injection and out-of-range or fractional sizes', () => {
  for (const field of ['chatFontFamily','uiFontFamily']) for (const value of ['../file.ttf','Arial','imported:../../file','";color:red','imported:'+'0'.repeat(63)]) {
    assert.equal(settingsSchema.safeParse({...oldSettings,[field]:value}).success, false);
  }
  for (const [field, maximum] of [['chatFontSize',28],['uiFontSize',20]] as const) {
    for (const value of [0,10,maximum+1,13.5,NaN,Infinity]) assert.equal(settingsSchema.safeParse({...oldSettings,[field]:value}).success, false);
    for (const value of [11,maximum]) assert.equal(settingsSchema.safeParse({...oldSettings,[field]:value}).success, true);
  }
  assert.deepEqual(typography({chatFontSize:Infinity,uiFontSize:NaN}), DEFAULT_TYPOGRAPHY);
  assert.throws(() => importedFamily('../evil'));
  assert.doesNotMatch(fontFamily('";color:red' as never), /color:red/);
});

test('fonts: importing copies and deduplicates bytes; fonts survive source removal and a new library instance', () => {
  const f = fixture();
  try {
    const original = fs.readFileSync(f.source), font = f.library.importFile(f.source);
    assert.equal(font.name, '我的字体'); assert.equal(font.format, 'woff2');
    assert.equal(font.bytes, original.length);
    assert.deepEqual(f.library.importFile(f.source), font);
    assert.equal(f.library.list().length, 1);
    fs.unlinkSync(f.source);
    const restored = new FontLibrary(f.data);
    assert.deepEqual(restored.list(), [font]);
    assert.deepEqual(Buffer.from(restored.read(font.id)), original);
    restored.remove(font.id); restored.remove(font.id);
    assert.deepEqual(restored.list(), []);
    assert.throws(() => restored.read(font.id), /不存在/);
    assert.deepEqual(fs.readdirSync(restored.directory), ['catalog.json']);
  } finally { f.dispose(); }
});

test('fonts: removing the managed copy never changes the original font', () => {
  const f = fixture();
  try {
    const original = fs.readFileSync(f.source), font = f.library.importFile(f.source);
    f.library.remove(font.id);
    assert.deepEqual(fs.readFileSync(f.source), original);
    assert.deepEqual(f.library.list(), []);
  } finally { f.dispose(); }
});

test('fonts: invalid containers, mismatched extensions, huge files and damaged table ranges are rejected', () => {
  const f = fixture();
  try {
    const valid = fs.readFileSync(f.source);
    assert.equal(validateFont(valid, '.WOFF2'), 'woff2');
    assert.throws(() => validateFont(valid, '.ttf'), /扩展名/);
    assert.throws(() => validateFont(valid.subarray(0, 40), '.woff2'));
    assert.throws(() => validateFont(Buffer.from('<html>not a font</html>'), '.ttf'));
    const damaged = Buffer.from(valid); damaged.writeUInt32BE(MAX_FONT_BYTES * 5, 16);
    assert.throws(() => validateFont(damaged, '.woff2'), /过大/);
    const ttf = Buffer.alloc(28); ttf.writeUInt32BE(0x00010000); ttf.writeUInt16BE(1, 4); ttf.writeUInt32BE(100, 20);
    assert.throws(() => validateFont(ttf, '.ttf'), /不完整/);
    const large = path.join(f.directory, 'too-large.ttf');
    fs.writeFileSync(large, 'x'); fs.truncateSync(large, MAX_FONT_BYTES + 1);
    assert.throws(() => f.library.importFile(large), /大小限制/);
    assert.throws(() => f.library.importFile('relative.ttf'), /本机/);
    assert.deepEqual(f.library.list(), []);
  } finally { f.dispose(); }
});

test('fonts: tampered copies and arbitrary path reads are rejected; broken catalogs remain intact', () => {
  const f = fixture();
  try {
    const font = f.library.importFile(f.source);
    const file = path.join(f.library.directory, font.id.slice(9) + '.woff2');
    const bytes = fs.readFileSync(file); bytes[bytes.length-1] ^= 1; fs.writeFileSync(file, bytes);
    assert.throws(() => f.library.read(font.id), /损坏/);
    assert.throws(() => f.library.read(f.source), /标识/);
    const catalog = path.join(f.library.directory, 'catalog.json');
    fs.writeFileSync(catalog, '{broken');
    assert.throws(() => f.library.list(), /原文件已保留/);
    assert.throws(() => f.library.importFile(f.source), /原文件已保留/);
    assert.equal(fs.readFileSync(catalog, 'utf8'), '{broken');
  } finally { f.dispose(); }
});

test('fonts: a full catalog rejects new fonts without leaving unmanaged files', () => {
  const f = fixture();
  try {
    f.library.list();
    const entries = Array.from({length:MAX_IMPORTED_FONTS}, (_,i) => ({id:'imported:'+i.toString(16).padStart(64,'0'),name:'fixture',format:'woff2',bytes:100}));
    fs.writeFileSync(path.join(f.library.directory,'catalog.json'), JSON.stringify(entries));
    assert.throws(() => f.library.importFile(f.source), /最多保存 24/);
    assert.deepEqual(fs.readdirSync(f.library.directory), ['catalog.json']);
  } finally { f.dispose(); }
});

test('fonts: managed font symlinks cannot expose another local file', {skip:process.platform==='win32'}, () => {
  const f = fixture();
  try {
    const font = f.library.importFile(f.source), file = path.join(f.library.directory,font.id.slice(9)+'.woff2');
    fs.unlinkSync(file); fs.symlinkSync(f.source,file);
    assert.throws(() => f.library.read(font.id), /符号链接/);
    f.library.remove(font.id);
    assert.ok(fs.existsSync(f.source));
  } finally { f.dispose(); }
});
