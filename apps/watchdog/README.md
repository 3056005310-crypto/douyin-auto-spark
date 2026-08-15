# Watchdog

`apps/watchdog` 是 Douyin Auto Spark 的外部可靠性守护服务。根项目仍然是纯 TypeScript + Playwright；只有这个子项目使用 Vite+、Cloudflare Workers、D1 和 Cron Triggers。

## 它做什么

- 用户安装并授权 GitHub App，不需要手动粘贴 PAT。
- OAuth 回调只用 GitHub user access token 验证“这个用户能访问哪些本 App installations”，验证完成立即丢弃，不写入 D1。
- D1 保存用户 session 哈希、installation 元数据和 guard 配置。
- Worker 需要操作 Actions 时，使用 GitHub App Private Key 生成 JWT，再换短期 installation access token。
- Cloudflare Cron 每 30 分钟扫描启用的 guard。
- 到达 `expected time + grace` 后：
  - 今天已经有 `schedule` / `workflow_dispatch` 成功记录：标记 healthy。
  - 今天有 queued / in_progress：不重复触发。
  - 今天有可重试的失败 run：请求 rerun。
  - 今天完全没有目标 run：调用 `workflow_dispatch`。
  - 每天最多执行 `max_attempts` 次恢复，并遵守 cooldown。
- guard 使用 D1 lease，降低 Cron 重叠执行时重复触发的风险。

## GitHub App 配置

创建一个 GitHub App，并建议使用以下配置：

1. **Callback URL**

   ```text
   https://<你的域名>/api/auth/callback
   ```

2. 打开 **Request user authorization (OAuth) during installation**。
3. Webhook 对当前轮询版本不是必需的，可以关闭 Active。
4. Repository permissions：
   - **Actions: Read and write**
   - Metadata 使用 GitHub 默认只读权限即可。
5. 允许用户选择 `Only select repositories`。
6. 生成一份 Private Key。

Watchdog 同时需要以下 GitHub App 信息：

- App ID
- App slug
- Client ID
- Client secret
- Private key

> JWT 的 issuer 使用 Client ID；App ID 用来过滤 OAuth 用户实际可访问的 installations。

## Cloudflare / D1

先安装依赖：

```bash
pnpm install
```

创建 D1：

```bash
cd apps/watchdog
pnpm exec wrangler d1 create douyin-auto-spark-watchdog
```

把返回的 `database_id` 写入 `wrangler.jsonc`，替换：

```text
REPLACE_WITH_D1_DATABASE_ID
```

应用 migration：

```bash
pnpm db:migrate:remote
```

配置 Secrets：

```bash
pnpm exec wrangler secret put GITHUB_APP_ID
pnpm exec wrangler secret put GITHUB_APP_SLUG
pnpm exec wrangler secret put GITHUB_CLIENT_ID
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY
```

如果生产域名与 Worker 自动识别的 origin 不一致，可额外配置普通变量：

```text
WATCHDOG_BASE_URL=https://watchdog.example.com
```

本地开发可使用 `apps/watchdog/.dev.vars`，该文件已被 gitignore：

```dotenv
GITHUB_APP_ID=123456
GITHUB_APP_SLUG=your-watchdog-app
GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxxxxxx
GITHUB_CLIENT_SECRET=xxxxxxxxxxxxxxxx
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
WATCHDOG_BASE_URL=http://localhost:5173
```

本地 D1 migration：

```bash
pnpm db:migrate:local
```

启动：

```bash
pnpm dev
```

或者从仓库根目录：

```bash
pnpm watchdog:dev
```

## Vite+ 边界

仓库根 `package.json` 不依赖 Vite/Vite+。`vite-plus` 只安装在 `apps/watchdog`。

Cloudflare Vite plugin 依赖 `vite` 这个 package identity，因此 `pnpm-workspace.yaml` 只做解析覆盖：

```yaml
overrides:
  vite: npm:@voidzero-dev/vite-plus-core@0.2.9
  vitest: 4.1.10
```

这不会把 Vite 添加到根 package 的 dependencies；它只是让 workspace 内需要 Vite peer 的插件解析到 Vite+ core。

## 部署

```bash
pnpm check
pnpm build
pnpm deploy
```

默认 Cron：

```text
*/30 * * * *
```

不需要给每个用户创建 Cron Trigger；一个 Worker Cron 扫描 D1 中所有启用的 guards。
