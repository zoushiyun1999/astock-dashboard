# legacy-sandbox · 已归档的沙箱时代产物

> 归档日期：2026-09-12
> 归档原因：原系统曾用 `workbuddy_sites_deploy` 动态沙箱部署看板，这两个文件是为那套方案服务的。
> 该部署方式已于 2026-09-10 废弃并被**明令禁止**（沙箱每次部署换 URL、空闲会停机，是历史上链接失效的根因），
> 见 `AGENTS.md` 硬性规则 9。

## 为什么从 `dashboard/` 移出来

`dashboard/` 是**公网站点根目录，整体发布到公网**（硬性规则 2）。这两个文件不是站点资源，
放在那里会被一起上传，属于"站点目录混入非站点文件"。移到这里既不丢失能力，也不再发布出去。

## 文件说明

| 文件 | 作用 | 现状 |
|---|---|---|
| `server.js` | 极简静态服务器（只用 Node 内置模块，监听 `$PORT`），沙箱需要它来起服务 | 不再需要 —— GitHub Pages 是静态托管，不需要应用进程 |
| `package.json` | 唯一作用是 `npm start` → `node server.js` | 同上 |
| `一键推送GitHub.bat` | 向导式脚本：`gh auth login` + `gh repo create astock-dashboard --source=. --push` | **已过时，不要直接双击运行**（2026-09-12 从项目根移入此处）。原因：本机访问不了 `github.com`，`gh` 的 git 协议走不通；而且仓库已经存在，再跑会把 remote 指错。保留仅供了解当初是怎么建的仓库 |

## 还需要它吗？

**日常不需要。** 想本地预览看板，用更简单的方式：

```bash
cd dashboard
python -m http.server 8899 --bind 127.0.0.1
# 然后打开 http://127.0.0.1:8899/
```

只有一种情况可能用得上：要在**没有 Python** 的机器上快速起一个静态服务，此时：

```bash
cd tools/legacy-sandbox && npm start     # 默认 3000 端口
```

> ⚠️ **不要**把它当作"重新启用沙箱部署"的借口。看板的部署形态是「GitHub Pages + 自有域名」，
> 发布只走 `tools/publish.sh`。
