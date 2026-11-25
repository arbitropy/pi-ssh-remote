<!--
pi-ssh-remote 中文说明文档，重点介绍它面向 Pi Agent 的设计、主要能力、常见使用场景、命令和安全机制。
-->

# pi-ssh-remote

**让 Pi 像操作本地项目一样操作远程服务器。**

[English Docs](README.md) · [社区](https://linux.do/)

`pi-ssh-remote` 是一个专门面向 Pi Agent 的 SSH 远程开发插件。

它维护一份全局的**远程项目**目录，并让 Pi 把「焦点」放在其中一个项目上。焦点在某个远程项目时，Pi 原有的 `read`、`write`、`edit`、`bash`、`grep`、`find`、`ls` 等工具会自动在该服务器上执行。Agent 不需要反复拼接 SSH 命令，也不需要先把代码下载到本地再修改，可以直接在服务器上查看文件、分析日志、修改代码和运行任务。

例如，你可以直接对 Pi 说：

```text
连接 befaq-prod，检查最近一次部署为什么失败，
在服务器上修复后告诉我改了什么。
```

Pi 会先 `remote list` 找到项目，再 `remote connect befaq-prod`，然后读取日志、修改文件并运行测试。整个过程中，它使用的仍然是熟悉的 Pi 工具，只是执行位置变成了远程服务器。

## 为什么它更适合 Agent

### 不需要给每一步都套一层 SSH

普通做法通常是让 Agent 不断执行：

```bash
ssh user@host "cd /path && ..."
```

命令一多，目录、引号、环境变量和连接状态都很容易出错。使用本插件后，只需要连接一次，后续文件读写和 Shell 操作都会自动在远端执行。

### Agent 知道自己正在操作哪台服务器

插件会把当前焦点、本会话的远程项目及其目录写入 Pi 的上下文，并显示在底部状态栏：

```text
gpu-box:/srv/project  ● befaq-prod  ○ staging
```

这样无论是用户还是 Agent，都能随时确认当前操作发生在本地还是远端，减少误操作。

### 命名的远程项目，所有会话共享

远程项目由名称、SSH 命令和工作目录组成，例如 `befaq-prod` = `ssh befaq-prod`，目录 `/opt/wifaq-production`，还可以附带备注、guard 标记、本地目录和端口转发。项目是全局的，与 Pi 启动时所在的本地文件夹无关，每个会话都能看到。Agent 通过 `remote list` 找到项目并按精确名称连接；你可以用 `/remote add`、`/remote edit`、`/remote remove` 管理它们。

### 焦点决定工具在哪里执行

每个会话记录自己用过的项目列表和一个**焦点**：`local` 或其中某个项目。焦点在远程项目时，Pi 的文件工具、Shell 工具和 `!` 用户命令都会通过 SSH 透明执行。切换是显式的（`/remote focus NAME|local`），Agent 可以在两台服务器之间对比，或回到本地代码库，而不用重新连接。如果焦点项目断线且无法重连，被路由的工具会返回明确的错误，绝不会悄悄回退到本地执行。

### 一轮对话里操作多个项目

`read`、`write`、`edit`、`bash`、`grep`、`find`、`ls` 都有可选参数 `target`：`"local"`，或本会话中已连接的项目名。不传时仍跟随焦点。这样 Agent 可以在同一轮里对比 `prod` 和 `staging`，或把远程项目里的片段复制到本地代码库，而不必来回切换焦点。用 `remote(action="connect", name="staging", focus=false)` 可以连接项目但不改变焦点。目标已保存但未连接、或名称不存在时，工具会报错并说明如何连接（或列出已连接的项目）；指定目标绝不会悄悄回退到本地。每个工具调用的标题前会显示 `[项目名]` 前缀标明执行位置（本地调用没有前缀），不同项目的调用使用各自的连接池连接和会话目录。

相对路径按目标项目的会话目录解析，绝对路径按原样使用：本地目录下的绝对路径不会再被改写成远程路径（Windows 主机上仍会把本地目录下的路径映射到远程目录）。项目记忆文件无论目标是谁，始终在本地读写。

### 非 Agent 引起的变化会写入对话

当远程状态的变化不是 Agent 自己调用 `remote` 工具造成的（你执行了 `/remote connect`、`focus`、`disconnect`、`forget`、`cd`、`edit`、`remove`、`ssh`，或连接断开后自动重连成功/失败），对话中会追加一行说明，例如 `[remote] User switched focus to local. Focus: local.`。它不会触发新的一轮；短时间内的多次变化会合并为一条；会话启动或恢复时不会添加。

### 断线后可以自动恢复

同一主机上的项目共享一条 SSH 连接；只要还有已连接项目在使用，连接意外断开时插件就会自动重连。会话会记住自己的项目列表：`/resume` 会把所有项目恢复为未连接状态并把焦点放回 local（不会自动连接）；`/reload`、`/new` 和 fork 则会在交互式 TUI 中重新连接之前已连接的项目。

### 对 Agent 上下文更友好

远程命令默认 30 秒超时，避免某个前台任务长期占住 Agent。远程文本读取会按范围获取，不再先下载完整文件；命令输出通过有界缓冲流式处理；同一轮远端工具共享 32 KB 输出预算，避免并行调用迅速占满上下文。超限命令的完整输出会保存到权限受限的临时文件，方便后续按需检查。

### 可以远端跑服务、本地改代码

端口转发绑定在项目的连接上，不会改变焦点。因此可以把远端服务映射到 `localhost`，同时把焦点放回 local，让 Pi 的文件和 Shell 工具继续操作本地项目。

这很适合下面这类场景：

- GPU 服务器运行模型，本地开发 Web UI；
- 远端启动 API，本地调试客户端；
- 远端运行训练监控，本地查看页面；
- 内网服务通过 SSH 隧道提供给本地工具使用。

## 和直接使用 SSH 有什么区别

| 直接执行 SSH | 使用 `pi-ssh-remote` |
|---|---|
| 每条命令都要重新拼接 SSH | 连接一次后，Pi 工具自动在远端执行 |
| 多次调用之间容易丢失目录 | 自动记住远程工作目录 |
| Agent 需要自己判断当前在哪台机器 | 系统上下文和底部状态栏会显示当前服务器 |
| 连接中断后需要手动恢复 | 当前会话内自动重连 |
| 文件修改、命令执行和端口转发各自处理 | 统一通过 `/remote` 和 Agent 工具管理 |
| 大量输出可能直接占满模型上下文 | 内置超时、折叠预览和输出上限 |

## 安装

```bash
pi install npm:pi-ssh-remote
```

本地要求 Node.js 20+。远程服务器需要提供 Bash、SFTP 和 GNU `timeout`。

## 快速开始

保存并连接一个项目：

```text
/remote add gpu-box "ssh -p 2202 root@gpu-box.example.com" /srv/project H100 训练机
/remote connect gpu-box
/remote cd /srv/train
/remote status
```

`/remote add NAME SSH CWD [备注...]` 保存项目（SSH 部分可以是带引号的完整命令，也可以只写 `tanim@islam30902` 这样的目标或 `~/.ssh/config` 里的别名）。`/remote connect gpu-box` 连接并聚焦该项目。此后 Pi 的文件和 Shell 工具都会操作远程服务器。底部状态栏先显示焦点，再显示本会话用过的其他项目（`●` 已连接，`○` 未连接）：

```text
gpu-box:/srv/train  ● befaq-prod  ○ staging
```

切回本地或切换到其他项目：

```text
/remote focus local
/remote focus befaq-prod
```

`/remote ssh root@host -p 22` 是快捷方式：查找或创建对应的项目（以别名或 `user-host` 命名，目录为 `~`）并连接。

### 项目指令

Pi 只会从本地目录树加载 `AGENTS.md` 和 `CLAUDE.md`，远程项目自己的说明原本无法到达模型。当焦点是已连接的远程项目时，本扩展会从远端读取这些文件，并与本地文件一起加入系统提示：

- **查找规则**与 Pi 本地规则一致：从项目当前目录向上直到 `/`，每个目录取 `AGENTS.override.md`、`AGENTS.md`、`AGENTS.MD`、`CLAUDE.md`、`CLAUDE.MD` 中第一个存在的普通文件（同一目录同时有 `AGENTS.md` 和 `CLAUDE.md` 时只取 `AGENTS.md`），外层目录在前。Pi 的 git worktree 去重规则不做处理。
- **大小限制**：每个文件 32 KB，总计 64 KB（优先保留离当前目录最近的文件）。被截断的文件末尾会附上 `[truncated: N of M bytes; read the file for the rest]`。UTF-8 BOM 会被去掉。
- **标签**：远程文件以 `ssh://<项目名>/<远端绝对路径>` 标注，模型可以与本地文件区分。
- **刷新**：连接、聚焦项目、切换目录（`/remote cd`、`chdir`）以及自动重连成功后，会通过一次往返重新读取。每次 Agent 运行前，超过 5 分钟的副本会被刷新，最多等待 5 秒；远端无响应时继续使用旧副本。
- **可见性**：Agent 调用 `remote` 的 `connect` 或 `focus`（以及改变适用文件的 `chdir`）时，结果中会列出刚获得的项目指令和项目记忆，切换当下就会出现在对话记录里。`/remote connect` 和 `/remote focus` 命令只显示一行摘要（`Loaded 2 instruction files and 1 memory entry for NAME`）。`/remote status` 会列出已加载的文件和记忆条目数。

### 项目记忆

直接告诉 Pi 要为当前聚焦的项目记住什么：

```text
记住这个项目使用 /opt/conda/bin/python，不要停止共享任务。
```

查看已有记忆和 ID：

```text
/remote memory [NAME]
```

每个项目的记忆保存在 `~/.pi/agent/ssh-remote-memories/projects/NAME.json`。当远程项目处于焦点且已连接时，它的记忆条目会作为系统提示的一部分（`ssh_remote_project_memory` 段，附带简短的文件编辑说明），并且只应用该项目的记忆。Pi 用本地工具编辑该文件。通过 ID 修改或删除：

```text
把记忆 deploy-command 改为使用 /opt/deploy/v2/run.sh。
删除记忆 obsolete-proxy-rule。
```

只有明确要求删除时才会删除。删除项目时其记忆文件会保留。

### 使用私钥文件登录

通过 `-i` 指定本地私钥：

```text
/remote ssh -i ~/.ssh/id_ed25519 root@gpu-box.example.com -p 2202
```

密钥路径必须是绝对路径或以 `~/` 开头。插件支持未加密私钥和带 passphrase 的私钥；对于加密私钥，Pi 会以遮罩方式询问 passphrase，并仅在当前进程内缓存以便自动重连，`/remote forget` 会清除它。指定 `-i` 后只使用该私钥，不会静默回退到 SSH Agent 或密码；不带 `-i` 时，每台主机依次尝试 SSH Agent、配置或默认私钥，最后才使用缓存密码或询问密码。默认私钥为 `~/.ssh/id_ed25519`、`~/.ssh/id_ecdsa` 和 `~/.ssh/id_rsa`，不存在的文件会跳过。

## 常见用法

### 1. 让 Pi 直接排查远程服务故障

```text
连接 ubuntu@training.example.com，进入 /opt/app。
先检查部署日志和 Git 状态，找出失败原因。
如果需要修改代码，先说明原因，再做最小修改并运行相关测试，
最后把 diff 和测试结果发给我。
```

连接完成后，Pi 后续的读文件、查日志、改代码和跑测试都会直接在服务器上进行。

### 2. 启动长时间训练任务

```text
在当前远程服务器检查训练命令和配置。
确认无误后用 nohup 在后台启动，并从一开始就重定向 stdout 和 stderr。
把 PID、输出目录和日志路径发给我，再检查一次进程是否仍在运行、日志是否已经开始写入。
```

插件默认限制前台命令的执行时间，但通过 `nohup` 等方式启动的后台任务可以继续在服务器运行。

### 3. 管理多台服务器

```text
/remote add train "ssh root@10.0.0.21" /srv/train 8xH100 训练机
/remote add staging "ssh -p 2222 ubuntu@staging.example.com" /opt/service 预发布 API
/remote edit staging guard=readonly local=/home/me/service
/remote list
/remote connect train
/remote connect staging
/remote focus train
```

项目全局保存，所有会话都能看到。两台服务器可以同时保持连接，用 `/remote focus` 在它们之间切换工具的执行位置。

### 4. 远端启动模型，本地开发界面

```text
/remote edit train forwards="7860:127.0.0.1:7860"
/remote connect train
/remote forward
/remote focus local
```

`/remote forward` 启动当前聚焦项目已保存的 `forwards`（或你传入的映射）。端口转发属于项目的连接，不会改变焦点，所以执行 `/remote focus local` 之后，访问本地 `localhost:7860` 仍然连接的是远程服务器上的 7860 端口，同时 Pi 的文件和 Shell 工具操作本地项目。断开该项目或执行 `/remote unforward` 即可停止转发。

### 5. 直接用自然语言操作

不想记命令时，可以直接告诉 Pi：

```text
连接 staging 项目，进入 /srv/api，然后检查 Git 状态。
```

```text
保存一个名为 prod-readonly 的项目：ssh deploy@prod.example.com，目录 /srv/api，
备注“线上只读”，然后聚焦到它。
```

```text
把远端 8000 端口转发到本地 8000，但代码工具继续留在本地。
```

## 命令说明

| 命令 | 作用 |
|---|---|
| `/remote` / `/remote list` | 以可复制的文本列出已保存项目（名称、ssh、目录、状态、备注）和当前焦点 |
| `/remote add NAME SSH CWD [备注...]` | 保存项目；SSH 可用带引号的完整命令或裸目标 |
| `/remote edit NAME key=value...` | 修改 `ssh`、`cwd`、`note`、`guard`、`local`、`forwards`；`key=` 清除可选字段。值会持续到下一个 `key=`，所以 `note=Staging server` 不需要引号 |
| `/remote remove NAME` | 删除已保存项目（保留其记忆文件） |
| `/remote connect NAME` | 连接项目（精确名称）并聚焦（Agent 的 `connect` 还支持 `focus=false`） |
| `/remote focus NAME\|local` | 把工具切到某个会话项目或回到本地；未连接的会话项目会被重新连接 |
| `/remote disconnect [NAME]` | 断开项目（默认当前焦点）；若它有焦点则焦点回到 local |
| `/remote status` | 查看焦点、本会话的项目、当前项目已加载的指令文件和记忆条目数，以及本地和每个已连接项目的 [Git 信息块](#工作在哪里git-状态与复制) |
| `/remote copy FROM TO [--overwrite]` | 在 `local:路径` 和/或已连接的 `项目:路径` 之间复制一个文件（最大 50 MB）；不受 guard 限制（见[复制文件](#工作在哪里git-状态与复制)） |
| `/remote memory [NAME]` | 展示项目的记忆条目、ID 和文件 |
| `/remote cd PATH` | 修改当前聚焦项目在本会话中的工作目录 |
| `/remote exec [--on NAME] [--timeout S] [--lines N] COMMAND` | 在当前聚焦项目（或指定的会话项目 `NAME`）中执行一次命令 |
| `/remote forward [MAPPING...]` | 为当前聚焦项目启动端口转发（默认使用其已保存的 `forwards`） |
| `/remote unforward` | 停止插件创建的端口转发（当前聚焦项目的；焦点为 local 时停止全部） |
| `/remote forget [NAME]` | 断开连接并清除该项目各跳的内存密码和密钥 passphrase |
| `/remote ssh ARGS...` | 快捷方式：查找或创建 `ssh ARGS...` 对应的项目（目录 `~`）并连接 |
| `/remote config` | 查看输出限制、预览行数和配置文件路径 |
| `/remote config display-lines 10` | 设置默认折叠显示行数（最大 50） |
| `/remote config read-max-lines 400` / `read-max-bytes 16384` | 设置远端读取预算 |
| `/remote config exec-max-lines 200` / `exec-max-bytes 8192` | 设置远端命令输出预算 |
| `/remote config turn-max-bytes 32768` | 设置每轮远端工具总输出预算 |

项目名称使用小写字母、数字、`.`、`_`、`-`（最长 64 个字符，以字母或数字开头），`local` 为保留名。`guard`（`readonly` 或 `confirm`）和 `local`（本地目录）会被记录并展示给 Agent 和列表；其中 `guard` 会对 Agent 的工具调用强制执行（见 [Guard（防护）](#guard防护)），`local` 是 `/remote status` 用来查找对应本地仓库的路径（见下文）。

### `remote` 工具

Agent 使用一个工具，包含这些 action：`list`、`add`、`edit`、`remove`、`connect`、`disconnect`、`focus`、`status`、`chdir`、`memory`、`forward`、`unforward`、`forget`、`copy`。`connect` 需要精确的项目名称（名称不存在时会返回几个相近的已保存项目），并支持 `focus=false`：只连接、不改变焦点。命令通过 `bash` 执行（用其 `target` 指定其他项目）；原来的 `exec` action 已移除。`remove` 只用于用户明确提出的请求。密码和密钥 passphrase 绝不会作为参数接收。

### 工作在哪里？Git 状态与复制

`/remote status`（以及 `remote(action="status")`）末尾会有一个 **Git** 信息块，列出 Pi 所在的本地目录，以及每个*已连接*且目录位于 git 仓库内的项目。它是只读的（不会 fetch；`git status` 不会改动索引），每个项目只执行一条很短的命令，并行运行，限时 10 秒：

```text
Git:
- local: main 4a5483d "Fix payment timeout"; clean; ahead 1 of origin/main; github.com/acme/api
- staging: main 9897131 "Raise GATEWAY_TIMEOUT to 20s"; 2 dirty; in sync with origin/main; github.com/acme/api
- prod: git: unavailable (not a git repository)
  staging: 1 behind local (main 4a5483d)
```

每行显示分支（或 `detached`）、HEAD 短哈希和提交标题、未提交条目数、相对 upstream 的领先/落后，以及规范化后的 origin（`git@host:org/repo.git`、`ssh://git@host/org/repo`、`https://host/org/repo` 都显示为 `host/org/repo`；凭据绝不会显示）。origin 相同的条目归为一组；组内有本地仓库时，每个远端条目会多一行对比：`same commit as local`、`N behind local`、`N ahead of local`、`N ahead, M behind local`，或在本地没有该提交时显示 `HEAD abc1234 not in local repo (git fetch?)`。组内没有本地仓库时，远端条目之间只比较 HEAD 是否相同。项目的 `local` 路径（`/remote edit NAME local=~/src/app`）会代替 Pi 所在目录作为该项目的本地对比仓库，显示为 `local:NAME`。不是仓库、没有 `git` 或超时只会让该条目显示一行 `git: unavailable (...)`，不会让整个 status 失败；Pi 所在目录不是仓库时则不显示本地条目。

**复制文件。** `/remote copy FROM TO [--overwrite]` 和工具的 `copy` action（参数 `from`、`to`、`overwrite`）在本机和/或已连接项目之间复制一个普通文件，两端的写法都是 `local:路径` 或 `项目:路径`。相对路径相对于该端的工作目录（项目的会话目录，或 Pi 所在的本地目录），`~` 表示该端的主目录。文件会先流式写入同目录下的临时文件，再重命名到位，因此中断或中止的复制不会留下残缺的目标；远端到远端的复制经由本机中转。目标已存在时会拒绝，除非加 `--overwrite`/`overwrite=true`；目录会被拒绝（请用 `bash` 配合 `tar`）；超过 50 MB 的文件也会被拒绝。Agent 的 `copy` 与 `write` 一样受**目标**项目的 [guard](#guard防护) 约束；源端的 guard 不起作用，本地目标不受限制，你自己输入的 `/remote copy` 与 `!` 一样从不受 guard 限制。

### Guard（防护）

项目的 `guard`（用 `/remote edit NAME guard=readonly|confirm` 设置，`guard=` 清除）限制 **Agent 的工具调用**在该项目上能做什么。它作用于在该项目上执行的 `write`、`edit`、`bash`（无论是跟随焦点还是使用 `target`），以及 Agent 向该项目发起的 `copy`；`read`、`grep`、`find`、`ls` 始终允许。本地调用和没有 guard 的项目不受影响，你自己输入的命令（`!` 和 `/remote exec`）也从不受 guard 限制。

| Guard | `write` / `edit` | `bash` |
|---|---|---|
| `confirm` | 每次调用都询问你（向该项目 `copy` 也一样） | 每次调用都询问你 |
| `readonly` | 直接拒绝，不弹窗（向该项目 `copy` 也一样）；Agent 会被告知请你操作或放宽 guard | 仅当命令可证明为只读时才直接运行，否则询问你 |

确认对话框标题为 `<项目> (guard: <guard>)`，内容包含工具名和完整命令、写入的路径与字节数、编辑的路径与修改摘要，或复制的源、目标与大小。`readonly` 下还会指出命令中第一个未被识别为只读的部分。如果你拒绝、对话框超时（RPC 等非 TUI 宿主为 30 秒），或在对话框打开时中止了 Agent，调用都会报错，远端不会执行任何操作，并且会告诉 Agent 不要重试。会话没有 UI（例如 print 模式）时，需要确认的调用会被直接拒绝并说明原因。并行调用会逐个询问。

只读分类器是保守的白名单，不是 shell 解释器：拿不准就判为“非只读”，并询问你。只有命令的每个部分（按 `|`、`||`、`&&`、`;`、换行拆分）都是已知的只读程序且不带危险参数时才通过，例如 `cat`、`grep`、`ls`、`find`（不含 `-delete`/`-exec`）、不带 `-i` 且无写入/执行命令的 `sed`、无输出重定向和 `system()` 的 `awk`、`git status|log|diff|show|branch`（仅列出）、`docker ps|logs|inspect`、`docker compose ps|logs`、`kubectl get|describe|logs`、`systemctl status|show|is-active`、`journalctl`、不带请求体、上传、输出文件且方法为 GET/HEAD 的 `curl`，以及 `ps`、`df`、`free`、`ss`、`ip addr` 等。开头的 `sudo -n [-u USER]`、`env`、`nice`、`timeout N`、`time` 会被穿透检查。输出重定向（`/dev/null` 和 `2>&1` 除外）、命令/进程替换、反引号、后台任务、子 shell、`eval`/`exec`/`source`、`xargs`、`tee`、解释器和数据库客户端（`psql`、`mysql`、`redis-cli`）一律不通过。

Guard 是针对 Agent 误操作的尽力而为的安全网，**不是安全边界**：命令可能以分类器看不到的方式造成破坏（写文件的脚本、远端的别名、列表中没有的参数）。需要真正的保护时，请使用权限本身受限的远程账号，例如给生产环境使用只读的 SSH 用户。

### 斜杠命令补全

`/remote` 支持 Pi 参数补全：输入 `/remote sta` 可补全 `status`，输入 `/remote connect ` 可从已保存的项目名中选择。

## 配置保存在哪里

远程项目保存在本地：

```text
~/.pi/agent/ssh-remote-config.json
```

```json
{
  "version": 2,
  "projects": {
    "befaq-prod": {
      "ssh": "ssh befaq-prod",
      "cwd": "/opt/wifaq-production",
      "note": "线上",
      "guard": "readonly",
      "local": "/home/me/wifaqdrf",
      "forwards": ["8080:127.0.0.1:80"]
    }
  },
  "displayLines": 5
}
```

`ssh` 和 `cwd` 必填（`cwd` 可以是 `~`），其余项目字段可选。同一文件还保存命令预览设置和模型输出预算。此外，每个 Pi session 会记录不含凭据的元数据（焦点和本会话的项目及其当前目录），用于 `/resume` 时列出这些项目；它不会自动重新连接。

私钥内容、密码和密钥 passphrase 都不会写入配置文件。插件仅在连接时从本地读取私钥；手动输入的密码和 passphrase 只会缓存在当前 Pi 进程的内存中。

**从 0.1.x 升级：** 首次启动时，旧的基于 endpoint 的文件会被重写为上述结构。原文件会复制为 `ssh-remote-config.v1.backup.json`（仅在该备份不存在时），每个 endpoint 变成一个项目，名称取自 ssh 别名（`ssh befaq-prod` 变为 `befaq-prod`）或 `user-host`，当前 endpoint 的概念被移除；按主机保存的记忆会复制到 `ssh-remote-memories/projects/NAME.json`（旧文件保留）。无法解析的文件绝不会被覆盖。

## 安全与输出限制

- 第一次连接新服务器时，需要确认主机密钥；
- 主机密钥发生变化时，会再次要求确认；
- 远程命令默认 30 秒超时；
- 远程文本读取默认最多返回 400 行或 16 KB，并支持通过 `offset`/`limit` 继续读取；
- 远程命令默认最多返回最后 200 行或 8 KB；
- 同一轮所有远端工具默认共享 32 KB 模型输出预算；
- 文本范围读取不会先通过 SFTP 下载完整远程文件；
- 超限命令会流式写入权限受限的本地临时文件，不在内存中累积完整输出；
- 各项限制可以配置，但不能超过扩展的硬安全上限；
- 折叠显示行数最大为 50，只影响界面，不会增加模型输出。

## 跳板机（ProxyJump）

无需手动创建本地 SSH 隧道，可直接通过一个或多个跳板机连接：

```text
/remote ssh -J bastion@gateway.example.com:2222 developer@dev.internal
/remote ssh -J bastion@gateway.example.com,relay@relay.internal developer@dev.internal
/remote ssh -o ProxyJump=bastion@gateway.example.com developer@dev.internal
```

每一跳独立确认主机密钥、解析 SSH 配置并认证。`-i` 只用于目标主机；跳板机使用自己的配置／默认私钥或 SSH Agent。没有命令行或配置覆盖时，跳板端口默认为 22，用户名默认为本地用户名，而非目标主机用户名。IPv6 跳板地址使用方括号，例如 `user@[2001:db8::1]:2222`。

重连会重新建立同一路径；断开会关闭整条连接链；`/remote forget` 也会清除该路径中跳板机的缓存凭据。跳板服务器必须允许向下一跳转发 TCP 连接。任何跳板失败时都不会回退为直连。

## 当前限制

连接仍使用 Node.js `ssh2` 库，不依赖本地 OpenSSH 可执行程序。命令参数支持 `-p`、`-l`、`-i`、`-J` 和 `-o ProxyJump=...`，包括逗号分隔的多跳路径。

读取 `~/.ssh/config` 中的 `Host` 通配／排除规则、`HostName`、`User`、`Port`、`IdentityFile`（可多条）、`IdentityAgent`、`IdentitiesOnly` 和 `ProxyJump`。命令行参数优先，每个跳板机独立解析。例如：

```sshconfig
Host gateway
    HostName gateway.example.com
    User bastion
    IdentityFile ~/.ssh/gateway_key

Host work
    HostName dev.internal
    User developer
    ProxyJump gateway
    IdentityFile ~/.ssh/work_key
```

使用 `/remote ssh work` 即可连接。未配置 `IdentityFile` 时，每一跳都会尝试上述默认私钥；因此普通 `ssh -J ...` 路径在两端均接受默认密钥时，也无需 SSH Agent。

这只是明确支持的配置子集，不是完整 OpenSSH 兼容层：不读取系统 SSH 配置；拒绝 `Match` 段及对当前主机生效的 `Include`、`ProxyCommand` 或主机名规范化配置，其他配置项未实现。`IdentitiesOnly yes` 会完全禁用 Agent 认证，`IdentityAgent none` 同样禁用它。配置中的相对密钥路径以用户主目录为基准，支持 `~/` 和 `%d/%h/%n/%p/%r/%u/%%` token。

## 版本发布

最新版本：[v0.1.16](https://github.com/petrichor20211/pi-ssh-remote/releases/tag/v0.1.16)

| 版本 | 日期 | 主要内容 |
|---|---|---|
| [0.1.16](CHANGELOG.md#0116---2026-11-12) | 2026-11-12 | 断开状态不再向提示词泄漏已保存的 SSH 路由、远程命令响应中止信号，并支持不带结构化提示词选项的宿主 |
| [0.1.15](CHANGELOG.md#0115---2026-10-11) | 2026-10-11 | 按主机解析 SSH 配置并发现默认密钥、保留路由的重连，以及界面与补全修复 |
| [0.1.14](CHANGELOG.md#0114---2026-09-28) | 2026-09-28 | ProxyJump 跳板连接、`/remote` 参数补全及更清晰的 SSH 工具路由 |
| [0.1.13](CHANGELOG.md#0113---2026-09-18) | 2026-09-18 | 工作目录不可用时平滑回退、延长 SSH 握手等待并修复 Windows 路径 |

完整的新增内容、行为变更和 Bug 修复记录请查看 [CHANGELOG.md](CHANGELOG.md)。

MIT License。

## 贡献者

感谢所有为 pi-ssh-remote 做出贡献的朋友！

<a href="https://github.com/petrichor20211/pi-ssh-remote/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=petrichor20211/pi-ssh-remote" alt="Contributors" />
</a>

欢迎参与贡献：在 [GitHub](https://github.com/petrichor20211/pi-ssh-remote) 上提交 issue 或 pull request。
