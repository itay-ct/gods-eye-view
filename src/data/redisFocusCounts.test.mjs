import {test} from 'node:test';
import assert from 'node:assert/strict';
import {redisFocusIdentity, formatRedisUpdateCount, installRedisFocusCounts} from './redisFocusCounts.js';
import {setOverlayEntries, getFocusedOverlayEntries, setOverlaySupplementalDetail, clearOverlaySource} from '../overlays/worldOverlay.js';

test('focus queries stable per-layer IDs rather than display labels', () => {
  assert.deepEqual(redisFocusIdentity({source:'tracked',id:'flights:abc123',title:'CHANGING CALLSIGN'}), {layer:'flights',id:'abc123'});
  assert.deepEqual(redisFocusIdentity({source:'tracked',id:'military:abc123'}), {layer:'military',id:'abc123'});
  assert.deepEqual(redisFocusIdentity({source:'tracked',id:'installations:base1'}), {layer:'military-installations',id:'base1'});
  assert.deepEqual(redisFocusIdentity({source:'ais-live-vessels',id:'vessel:123456789'}), {layer:'ais-live-vessels',id:'123456789'});
  assert.deepEqual(redisFocusIdentity({source:'bikeshare-selected',id:'city:42',metadata:{redisLayer:'bikeshare',redisId:'42'}}), {layer:'bikeshare',id:'42'});
  assert.deepEqual(redisFocusIdentity({source:'tracked',id:'satellites:5'}), {layer:'satellites',id:'00005'});
  assert.equal(formatRedisUpdateCount(1234), '≈ 1,234 updates');
  assert.equal(formatRedisUpdateCount(0), '≈ 0 updates');
  assert.throws(() => formatRedisUpdateCount(-1));
});

test('focused count survives source label refresh, replaces itself and clears on deselection', () => {
  const source = 'cms-focus-test';
  const entry = {id:'abc',position:{x:1,y:2,z:3},title:'ABC',details:['1000 ft'],selected:true};
  try {
    setOverlayEntries(source,[entry]);
    setOverlaySupplementalDetail(source,entry.id,'≈ 2 updates');
    const read = () => getFocusedOverlayEntries().find(e => e.source===source).details;
    assert.deepEqual(read(), ['1000 ft','≈ 2 updates']);
    setOverlayEntries(source,[{...entry,details:['2000 ft']}]);
    assert.deepEqual(read(), ['2000 ft','≈ 2 updates']);
    setOverlaySupplementalDetail(source,entry.id,'≈ 3 updates');
    assert.deepEqual(read(), ['2000 ft','≈ 3 updates']);
    setOverlaySupplementalDetail(source,entry.id,'');
    assert.deepEqual(read(), ['2000 ft']);
  } finally {setOverlaySupplementalDetail(source,entry.id,'');clearOverlaySource(source);}
});

test('No Redis installs no polling or viewer listeners', () => {
  installRedisFocusCounts({get viewer(){throw new Error('No Redis touched viewer');}});
});
