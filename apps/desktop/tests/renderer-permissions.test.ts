import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { allowsLocalFonts, isTrustedRendererUrl } from '../src/main/renderer-permissions';

test('renderer permissions allow local fonts only in the workbench main frame', () => {
  const file = path.resolve('dist/renderer/index.html'), url = pathToFileURL(file).href;
  const details = {isMainFrame:true,requestingUrl:url};
  assert.equal(allowsLocalFonts('local-fonts',true,details,file),true);
  assert.equal(allowsLocalFonts('local-fonts',false,details,file),false);
  assert.equal(allowsLocalFonts('local-fonts',true,{...details,isMainFrame:false},file),false);
  assert.equal(allowsLocalFonts('local-fonts',true,{isMainFrame:true},file),false);
  for (const requestingUrl of ['https://example.org','data:text/html,hello','about:blank',pathToFileURL(path.resolve('other.html')).href]) {
    assert.equal(allowsLocalFonts('local-fonts',true,{...details,requestingUrl},file),false);
  }
  for (const permission of ['clipboard-read','media','geolocation','fileSystem','unknown']) assert.equal(allowsLocalFonts(permission,true,details,file),false);
});

test('renderer origin validation preserves local files and limits development to the configured origin', () => {
  const file = path.resolve('dist/renderer/index.html'), url = pathToFileURL(file).href;
  assert.equal(isTrustedRendererUrl(url+'#settings',file),true);
  const dev = 'http://127.0.0.1:5173';
  assert.equal(isTrustedRendererUrl(dev+'/#settings',file,dev),true);
  for (const value of ['invalid',url,'http://127.0.0.1:5174','http://localhost:5173','http://user:password@127.0.0.1:5173','https://127.0.0.1:5173']) assert.equal(isTrustedRendererUrl(value,file,dev),false,value);
});
