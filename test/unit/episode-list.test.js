const { test } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const hg = require('../../src/server/native/hongguo');
const appSource = require('../../src/server/native/app-source');
const { getPlaybackDevice } = require('../../src/server/native/playback-device');
const { startServer } = require('../../src/server');

function buildWebPlayerHtml(seriesId, vidList) {
  const payload = {
    loaderData: {
      'player_(series_id)/page': {
        isSuccess: true,
        series_id: String(seriesId),
        seriesDetail: {
          series_id: String(seriesId),
          series_name: '官网测试短剧',
          series_cover: 'https://p3-novel.byteimg.com/novel-pic/web~tplv-shrink:640:0.image',
          series_intro: '官网简介',
          tags: ['都市'],
          episode_right_text: `全${vidList.length}集`,
          vid_list: vidList,
          celebrities: [],
        },
      },
    },
  };
  return `<!doctype html><html><script>window._ROUTER_DATA = ${JSON.stringify(payload)};</script></html>`;
}

test('fetchEpisodeList succeeds via v5-signed App detail primary without hitting hongguoduanju.com', async t => {
  const originalRequest = appSource.requestJson;
  const originalAxiosGet = axios.get;
  t.after(() => {
    appSource.requestJson = originalRequest;
    axios.get = originalAxiosGet;
    appSource.clearEntryCache();
    hg.clearEpisodeCache();
    getPlaybackDevice.reset();
  });

  appSource.clearEntryCache();
  hg.clearEpisodeCache();
  getPlaybackDevice.reset();

  axios.get = async () => {
    throw new Error('should not hit hongguoduanju.com when App primary succeeds');
  };
  appSource.requestJson = async (url) => {
    if (url.includes('register')) {
      return { code: 0, device_id_str: '999200', install_id_str: '888200' };
    }
    return {
      code: 0,
      data: {
        '7711182077240036377': {
          video_data: {
            series_id: '7711182077240036377',
            series_title: '全球死考：刚下刑场你让我去考试三季',
            series_intro: '剧情简介',
            episode_right_text: '全2集',
            video_list: [
              { vid: '7711182189383142424', vid_index: 1, series_id: '7711182077240036377' },
              { vid: '7711182189731269656', vid_index: 2, series_id: '7711182077240036377' },
            ],
          },
        },
      },
    };
  };

  const detail = await hg.fetchEpisodeList('7711182077240036377', { force: true });
  assert.equal(detail.source, 'app');
  assert.equal(detail.series_id, '7711182077240036377');
  assert.deepEqual(detail.episodes.map(ep => ep.vid), ['7711182189383142424', '7711182189731269656']);
});

test('parseEpisodeListHtml rejects obfuscated v1_ tokens from hongguoduanju.com', () => {
  const html = buildWebPlayerHtml('7711182077240036377', [
    'v1_dnYsWS_sCDzIfAOQre7MChnU8Zs',
    'v1_dEbIIJaNaGbuv8BGn4cuomJ7kK4',
  ]);
  assert.throws(() => hg.parseEpisodeListHtml(html, '7711182077240036377'), /官网分集数据异常/);
});

test('fetchEpisodeList falls back to hongguoduanju.com when App detail fails and web has numeric vid_list', async t => {
  const originalRequest = appSource.requestJson;
  const originalAxiosGet = axios.get;
  t.after(() => {
    appSource.requestJson = originalRequest;
    axios.get = originalAxiosGet;
    appSource.clearEntryCache();
    hg.clearEpisodeCache();
    getPlaybackDevice.reset();
  });

  appSource.clearEntryCache();
  hg.clearEpisodeCache();
  getPlaybackDevice.reset();

  appSource.requestJson = async (url) => {
    if (url.includes('register')) {
      return { code: 0, device_id_str: '999201', install_id_str: '888201' };
    }
    return { code: 1001, data: {} };
  };
  axios.get = async () => ({
    status: 200,
    data: buildWebPlayerHtml('7711182077240036377', ['10001', '10002']),
  });

  const detail = await hg.fetchEpisodeList('7711182077240036377', { force: true });
  assert.equal(detail.source, 'web');
  assert.deepEqual(detail.episodes.map(ep => ep.vid), ['10001', '10002']);
});

test('fetchEpisodeList preserves EMPTY_RESPONSE code across web failure and /api/series returns actionable guidance', async t => {
  const originalRequest = appSource.requestJson;
  const originalAxiosGet = axios.get;
  t.after(() => {
    appSource.requestJson = originalRequest;
    axios.get = originalAxiosGet;
    appSource.clearEntryCache();
    hg.clearEpisodeCache();
    getPlaybackDevice.reset();
  });

  appSource.clearEntryCache();
  hg.clearEpisodeCache();
  getPlaybackDevice.reset();

  appSource.requestJson = async (url) => {
    if (url.includes('register')) {
      return { code: 0, device_id_str: '999202', install_id_str: '888202' };
    }
    throw Object.assign(new Error('App 接口返回空响应，可能是签名或设备鉴权问题'), { code: 'EMPTY_RESPONSE' });
  };
  axios.get = async () => ({
    status: 200,
    data: buildWebPlayerHtml('7711182077240036377', [
      'v1_dnYsWS_sCDzIfAOQre7MChnU8Zs',
      'v1_dEbIIJaNaGbuv8BGn4cuomJ7kK4',
    ]),
  });

  await assert.rejects(
    hg.fetchEpisodeList('7711182077240036377', { force: true, deadline: Date.now() + 2000 }),
    err => err.code === 'EMPTY_RESPONSE' && /App接口/.test(err.message) && /官网数据源/.test(err.message)
  );

  hg.clearEpisodeCache();
  const { server, port } = await startServer(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;
  const home = await fetch(base);
  const cookie = home.headers.get('set-cookie').split(';')[0];

  const response = await fetch(`${base}/api/series/7711182077240036377`, {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.match(body.error, /生成新的设备ID/);
});
