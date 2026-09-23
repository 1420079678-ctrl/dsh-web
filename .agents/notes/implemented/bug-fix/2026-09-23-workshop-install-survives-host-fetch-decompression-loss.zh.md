# Agent Note: Workshop 安装经受住宿主 fetch 解压失效

Status: implemented

## Problem

在 `0.1.7-alpha.2` 宿主上，从 Workshop 卡片安装任何皮肤都会失败。卡片发往 loopback 的 `POST /api/market/install-skin {"id":"orca-link"}` 返回：

```json
{"ok":false,"error":"write","message":"Unexpected token '\u000b', \"\u000bz\u000f\u0000\ufffd...\" is not valid JSON"}
```

market 的 host 半区自行抓取 `https://dsh-market.com/manifest/skins.json` 并对响应体做 `JSON.parse`。宿主实际收到的是 20 484 字节的裸 brotli，开头为 `0b 7a 0f 00 e4 af 74 f6`；解码后的 manifest 是 92 901 字节。

成因在宿主层面，早于本插件。alpha.2 启动器在 `runProfile()` 中导入 `@deepseek-ai/dsh-http-proxy`，而该包（以及 `@deepseek-ai/dsh-web-fetch-http`）会导入 npm 版 `undici`。仅仅导入 npm undici 8.x 就会执行其 `lib/global.js` 初始化，把 dispatcher 同时装进 `Symbol.for('undici.globalDispatcher.2')` 与旧版 `Symbol.for('undici.globalDispatcher.1')`。Node 内置 `fetch()` 读取的是旧版槽位，而放在那里的 npm undici v8 `Dispatcher1Wrapper` 会丢掉 `content-encoding` 头与自动解压。node 25.8.1 上的最小复现：

- 先 `await import('<dsh>/node_modules/undici/index.js')` 再 `fetch(url)`：`content-encoding: null`，响应体以 `0b 7a 0f 00` 开头，`JSON.parse` 抛错。
- 不导入时同样的 fetch：`content-encoding: br`，解码后 92 901 字节，可正常解析。

一旦 npm undici 被导入（alpha.2 的启动必然如此），宿主进程里所有裸 `fetch()` 都会受影响。

## Decision

market 安装器在其唯一的 fetch 收口处（`packages/dsh-market/src/core/installer.ts` 的 `fetchWithTimeout`）请求 identity 编码，manifest 与每个资源下载都覆盖：

```ts
return await fetchImpl(url, {
  signal: AbortSignal.timeout(timeoutMs),
  headers: { 'accept-encoding': 'identity' },
})
```

源站遵守该请求：manifest 以 92 901 字节未压缩、无 `content-encoding` 抵达，因此 `JSON.parse` 与资源落盘都不再依赖宿主 fetch 是否解压。`packages/dsh-market/src/core/installer.test.ts` 新增回归用例复刻故障宿主——除非请求要求 identity，其 mock 一律返回裸 brotli——并断言整次皮肤安装成功且文件字节正确。

根治属于上游：宿主不该让 npm undici 覆盖 Node 内置 fetch 所读的旧版全局 dispatcher 槽位。本仓库不能修改 DSH checkout，因此这里的 identity 请求就是兼容契约。

## Alternatives considered

- **改 `@deepseek-ai/dsh-http-proxy`，不安装 npm undici 的 dispatcher。** 本仓库否决：那是 DSH 源码，仓库规则禁止修改 DSH checkout。它仍是根治方案的上游归属。
- **在安装器里自行解压。** 否决：故障状态下该 wrapper 连 `content-encoding` 一并隐藏，压缩体与损坏体无法区分。
- **改用宿主 `ctx.web` 服务而不是全局 fetch。** 否决：它包装的 npm undici fetch 确实能解压，但为了一个请求头就能解决的问题去改动本模块的服务注入与 SSRF 策略并不值得；安装器已经钉死 `MARKET_ORIGIN`。
- **探测 dispatcher 是否损坏并跳过请求。** 否决：没有公开且版本稳定的方式询问全局 dispatcher 是否解压，而且安装器仍然需要一条降级传输。

## Consequences

manifest 与资源始终不压缩传输（皮肤 manifest 约 93 KB，而非 brotli 约 20 KB）——为字节正确付出一点带宽。

其他在宿主侧读取压缩响应的消费者暴露在同一问题下，本次有意留给各自的改动：`dsh-plugin-manager` 的 npm registry 探测、`dsh-remote-web-ui` 的更新探测、`dsh-usage` 的 provider 探测。它们要么吞掉解析失败，要么报出故障；后续应给它们同样的 identity 契约或迁到能解压的传输。

运行中的 `dsh web` 进程仍持有修复前的模块，因此宿主重启前 Workshop 安装依旧失败；host 半区只随服务重启而重载。

## Testing

- `pnpm --filter @linxin666/dsh-client-ui-market test`（92 个用例；新增用例在缺少该请求头时失败）。
- `pnpm --filter @linxin666/dsh-client-ui-market typecheck`。
- 在故障宿主的复刻里端到端验证：导入 npm undici，再用构建产物执行 `installAsset('skin', 'orca-link', { dshHome })` 打真实源站。结果 `{ok:true,...,files:15}`；`skin.json` 解析出 `id: orca-link`、`version: 0.1.0`；`assets/orca-link-light-hero.webp` 带合法 `RIFF....WEBP` 头。同一复刻里的裸 fetch 仍返回不可解析字节。
- `pnpm build`、`pnpm libs:write`、`pnpm libs:check`（随源码指纹刷新已提交的 `lib/`）。
