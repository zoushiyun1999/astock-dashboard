# GitHub 上线清单（照着做即可）

> 目标：把本地代码推到 GitHub，打开 Pages 静态托管，配好密钥。  
> 做完之后你就会拿到一个**不会再变**的看板网址。  
> 预计 10 分钟。带 ⌨️ 的是要执行的命令，其余是网页点选。

---

## 第 0 步：确认命令行工具装好了

⌨️ 在终端（Git Bash）里执行：

```bash
gh --version
```

看到 `gh version 2.x.x` 就是装好了。如果提示找不到命令，说明安装没成功，告诉我。

---

## 第 1 步：登录授权（只需做一次）

⌨️ 执行：

```bash
gh auth login
```

会出现选择，照这样按回车：

1. `What account do you want to log into?` → 选 **GitHub.com**
2. `What is your preferred protocol for Git operations?` → 选 **HTTPS**
3. `Authenticate Git with your GitHub credentials?` → 输入 **Y**
4. `How would you like to authenticate GitHub CLI?` → 选 **Login with a web browser**

然后屏幕会显示**一个 8 位字母数字代码**（类似 `ABCD-1234`）：

```
! First copy your one-time code: ABCD-1234
- Press Enter to open github.com in your browser...
```

- 复制这串代码
- 按回车，浏览器会自动打开
- 网页上粘贴这串代码 → 点 **Authorize github**（绿色的授权按钮）
- 回到终端看到 `✓ Authentication complete` 就成功了

> 授权只做一次，之后永久有效。



---

## 第 2 步：建仓库并推送

### 方式 A：命令行（前提是你的终端能连上 github.com）

登录成功后，把这行命令的结果告诉我，或者直接让我执行：

⌨️

```bash
gh repo create astock-dashboard --public --source=. --remote=origin --push
```

说明：

- `astock-dashboard` 是仓库名，可以改成你喜欢的（只能用英文、数字、横线）
- **必须是 `--public`**：GitHub **免费账号的私有仓库不支持 Pages**，公开仓库才能生成网址。
  公开的只是简报内容（本来就是公开信息）；微信推送的密钥存在 Settings → Secrets 里，不会出现在代码里，不会被看到。
- 这条命令会一次性做完：建仓库 → 关联本地 → 推送代码
- 如果这条命令报网络错误（`CONNECT tunnel failed` / `unexpected EOF`），说明当前终端到 github.com 不通，改用下面的「令牌方式」由我用 API 推送

执行完会显示一个地址，形如：

```
https://github.com/你的用户名/astock-dashboard
```

**这个地址就是你的仓库主页，先记下来。**

### 方式 B：令牌方式（终端连不上 github.com 时用这个，推荐）

本机到 `github.com` 的 git 端口不通，但 `api.github.com` 通，所以可以绕过 git 直接调 API 推送：

1. 浏览器打开 **https://github.com/new** 建仓库：
   - Repository name：`astock-dashboard`
   - 选 **Public**（免费账号私有仓库用不了 Pages）
   - 勾选 **Add a README file**
   - 点 **Create repository**
2. 打开 **https://github.com/settings/tokens** → **Generate new token** → **Generate new token (classic)**
   - Note：`astock-dashboard`
   - Expiration：选 **No expiration**
   - 勾选 **`repo`**（整组）和 **`workflow`**
   - 拉到底点 **Generate token**
   - 复制那串 **`ghp_` 开头**的字符串（只显示一次）
3. 把「仓库地址」和「令牌」发给我，剩下的我来跑：
   ```bash
   node tools/gh_push_api.js --repo 用户名/astock-dashboard
   ```
4. 推送完成后，去 **https://github.com/settings/tokens** 点 **Delete** 把令牌删掉即可
   （以后需要再生成一个；也可以留着，方便每日自动更新）

> 令牌只用来读写这一个仓库。删掉不影响已经上线的内容。

---

## 第 3 步：打开 Pages（拿到网址的关键一步）

1. 浏览器打开你的仓库主页（上一步那个地址）
2. 点顶部一排标签里的 **Settings**（齿轮图标，在最右边）
3. 左侧菜单找到 **Pages**（在 Code and automation 分类下）
4. 右侧 **Build and deployment** 区域：
   - **Source** 选 **GitHub Actions**（不是 "Deploy from a branch"！）
5. 不用点保存，选完自动生效

> ⚠️ 这一步最容易选错。必须是 **GitHub Actions**，因为我们的发布流程写在 `.github/workflows/publish.yml` 里。

选完之后，回到仓库顶部的 **Actions** 标签，应该能看到一个叫「发布看板」的工作流正在跑（黄色圆点）。等它变成绿色 ✓，就说明看板已经上线了。

---

## 第 4 步：找到你的看板网址

在 **Actions** 标签页里，点那次成功的「发布看板」运行记录，页面底部会有一个 **github-pages** 区域，里面就是网址：

```
https://你的用户名.github.io/astock-dashboard/
```

**这个网址是固定的，永远不会变。** 打开看看是不是你的看板。

把它填进 `config/site.json` 的 `siteUrl` 和 `fallbackUrl`：

```json
{
  "siteUrl": "https://你的用户名.github.io/astock-dashboard/",
  "fallbackUrl": "https://你的用户名.github.io/astock-dashboard/",
  "mirrorUrl": "",
  "domainExpiry": ""
}
```

---

## 第 5 步：配密钥（微信推送用）

### 5.1 拿到 Server酱 key

登录 `sct.ftqq.com` → 复制你的 SendKey（形如 `SCTxxxxxx...`）。

> 建议点一次「重置」，换一个新的 key——旧 key 曾经明文写在了自动化任务里，属于泄露。

### 5.2 存到 GitHub

1. 仓库主页 → **Settings**
2. 左侧 **Secrets and variables** → **Actions**
3. **Secrets** 标签 → 右上角 **New repository secret**
   - Name：`SCT_KEY`
   - Secret：粘贴你的 SendKey
   - 点 **Add secret**

### 5.3 存网址变量（可选，但建议配）

同一个页面切到 **Variables** 标签 → **New repository variable**，依次添加：

| Name            | Value            |
| --------------- | ---------------- |
| `SITE_URL`      | 第 4 步拿到的网址       |
| `FALLBACK_URL`  | 同上               |
| `MIRROR_URL`    | 留空（等你以后配了国内镜像再填） |
| `DOMAIN_EXPIRY` | 留空（等你买了域名再填日期）   |

---

## 第 6 步：验证一切正常

⌨️ 本地执行体检脚本（它会真的去访问你的网址）：

```bash
node tools/health_site.js
```

看到 `✓ 主站（自有域名）：HTTP 200` 和 `✓ 全部正常` 就大功告成。

> 注意：这个脚本读的是 `config/site.json`，所以要先完成第 4 步的填写。

---

## 以后每天怎么用

什么都不用做。流程是这样的：

```
定时任务生成简报 → 写入 data.js → 推送到 GitHub
   → 自动触发「发布看板」→ 网址内容更新（网址不变）
   → 微信收到提醒
```

你只需要打开那个固定网址。**页面自己会每分钟检查一次有没有新数据**，有的话底部弹出提示，点一下就更新了，不用手动刷新。

---

## 出问题怎么办

| 现象                                                | 原因                               | 处理                   |
| ------------------------------------------------- | -------------------------------- | -------------------- |
| Actions 里「发布看板」是红色 ✗                              | Pages 的 Source 没选 GitHub Actions | 回第 3 步检查             |
| 网址打开是 404                                         | 刚部署完要等 1–2 分钟                    | 等一会儿再刷新              |
| 网址打开显示 "404 There isn't a GitHub Pages site here" | 工作流还没跑成功                         | 去 Actions 看第一次运行是否成功 |
| 收到微信但打开是旧内容                                       | 浏览器缓存                            | 等一分钟，页面底部会弹更新提示      |
| 完全打不开                                             | 国内网络访问 github.io 不稳定             | 这一步之后再配国内镜像（告诉我即可）   |

---

## 还有一件事：域名（可稍后做）

现在拿到的是 `xxx.github.io` 这种地址，它已经**不会变了**，但有两个弱点：

1. 国内访问可能慢或不稳
2. 地址跟 GitHub 绑定，万一哪天你想换托管商，地址就得跟着换

解决办法是买一个自己的域名（一年约 ¥30–60），做一个 CNAME 解析指向它。这样网址变成 `asx.你的域名.com`，以后换任何托管商，网址都不变——这才是真正的"链接永不丢失"。

想做的话告诉我，我会帮你配 `dashboard/CNAME` 和 DNS 解析记录。
