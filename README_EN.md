# NarraFork

[简体中文](README.md) · English

**An efficient durable harness for collaboration across people, models, and devices**

NarraFork is a self-hosted workspace for AI-assisted coding and collaboration. Deploy it on your own computer or server, then use your browser to organize AI conversations, work with code and terminals, and manage agent context and permissions—for yourself or your team.

[Quick Start](#quick-start) · [Core Capabilities](#core-capabilities) · [Development](#development) · [Documentation](#documentation) · [License](#license)

![NarraFork conversation and file preview](docs/images/overview.png)

## Core Capabilities

| Capability | What you can do |
| --- | --- |
| Multi-session workspaces | [Organize conversation panels](#organize-conversation-panels), save and restore layouts, and switch between tasks |
| Multi-agent collaboration | Delegate exploration, implementation, and review tasks; [message subagents directly and take over their conversations](#message-subagents-and-take-over-conversations) |
| Context management | Gain unprecedented control over context with [low-cost forks](#low-cost-forks) and [reversible, editable compaction](#reversible-editable-compaction) |
| Development tools | Read and edit files, search code, run commands, and use [interactive terminals](#interactive-terminals) and Git workflows |
| Permissions and approvals | Configure access rules for directories and commands, and approve operations that require authorization |
| Model integrations | Configure different model providers, including Anthropic- and OpenAI-compatible protocols |
| Extensions and automation | Use Skills, routines, and MCP tools to turn repetitive work into reusable workflows |
| Team knowledge | Share projects, exchange in-app messages, and use a knowledge base with access controlled by clearance levels and tags |
| Cross-device workflows | Access the workspace through a browser, [connect remote execution devices](#connect-remote-execution-devices), and [follow tasks on your phone](#follow-tasks-on-your-phone) |

Simplified Chinese and English are currently supported. The architecture is ready for additional languages, and translation contributions are welcome.

## Feature Highlights

### Low-Cost Forks

![Forking from a historical message](docs/images/fork-from-message.png)

Instead of storing a separate JSONL file for every conversation, NarraFork stores messages in a database. Forking copies only the necessary references, so shared context is stored once rather than duplicated with every fork.

### Reversible, Editable Compaction

Each compaction leaves a "compaction marker" in the conversation. Messages before the marker remain visible to humans, but are replaced by the compaction summary for the model. Through the marker, you can view and edit the summary, or undo the compaction to restore the corresponding conversation history. Compaction is no longer an invisible, irreversible, one-time operation.

![Compaction marker in a conversation](docs/images/compact-marker.png)

![Undoing and editing a compaction summary](docs/images/compact-actions.png)

### Interactive Terminals

There is no need to repeat environment variables or add long `ssh` and `sshpass` prefixes every time you run a command. Once you log into a remote machine and configure the environment in an interactive terminal, the agent can keep running commands in that same session. You can watch input and output in real time and intervene whenever needed.

### Organize Conversation Panels

Drag a conversation from RecentTabs on the left to the right to create a workspace and manage multiple conversations in one interface.

![Managing conversations side by side in a workspace](docs/images/workspace.png)

### Message Subagents and Take Over Conversations

Open a subagent's conversation directly to send messages, add requirements, or take over the discussion—without routing everything through the primary agent.

![Opening and interacting with a subagent conversation directly](docs/images/subagent-conversation.png)

### Connect Remote Execution Devices

![Installing the remote executor on a target machine](docs/images/remote-executor-install.png)

Connect your computer or server so agents can read and write files and run commands on the designated machine without switching workspaces back and forth.

### Follow Tasks on Your Phone

![Swipe-left message menu on mobile](docs/images/mobile-swipe-menu.jpg)

Mobile access is an everyday way to use NarraFork, not just a fallback. We designed interactions specifically for phones—for example, swiping left on a conversation message opens its action menu. Rich conversation controls remain within reach on a small screen, so you can do more than check progress.

## Quick Start

### Run a Prebuilt Binary

Visit [GitHub Releases](https://github.com/NarraFork/narrafork/releases) and download the executable for your operating system and CPU architecture from the release's Assets section. You do not need to install Bun or build the project yourself. Git is still required for project and version management.

- **Windows**: Download the `.exe` file and run it directly.
- **Linux / macOS**: Make the downloaded file executable, then run it. For example:

  ```sh
  chmod +x ./narrafork-<version>-<platform>-<arch>
  ./narrafork-<version>-<platform>-<arch>
  ```

  Replace the example filename with the actual name of your download.

For older x64 CPUs, you can choose the compatibility variant with a `baseline` suffix. Note that this is not a distinction based on AVX-512 support: according to [Bun's current documentation](https://bun.com/docs/bundler/executables), x64 builds have been unified, and `baseline` remains as a compatibility alias. Refer to the specific release notes for details.

After startup, open `http://localhost:7778`. Use the address shown in the startup logs if it differs.

### Run from Source

Download this repository's source code and open a terminal at the repository root.

#### Prerequisites

- **Bun**: We recommend the version specified by `packageManager` in [package.json](package.json).
- **Git**: Required for project and version management.
- **Model credentials**: Prepare an API key or the appropriate authorization for your chosen provider. NarraFork does not include model service credits.

#### Install and Run

```sh
bun install --frozen-lockfile
bun run build
bun run start
```

Startup runs database migrations before starting the service. The default address is `http://localhost:7778`; if you change the port, use the address shown in the startup logs.

### Complete Your First Task

1. Open the page and register an account. The first registered user becomes the administrator.
2. Configure model providers and available models in Settings.
3. Create a project linked to a local Git repository, or start a conversation from a working directory.
4. Choose a model and describe your task. AI conversations in NarraFork are called "Narrators."
5. Review file changes and tool results. When a permission request appears, verify the operation before approving it.

Start with a small task, such as: "Read this repository and explain its entry points and main modules. Do not modify any code yet."

### Data and Access Boundaries

- The default data directory is `~/.narrafork/`, which contains the database and configuration. Back it up and protect its access permissions.
- By default, the service listens on `localhost` for local access only. Configure the listening address and network access before connecting from a phone or allowing other team members to connect.
- **Self-hosting does not mean all model inference runs locally.** When you use external model or tool services, the conversation, code, or tool results needed for a request may be sent to those services.
- **Agents can actually modify files and execute commands.** Permission approvals are not an operating-system sandbox. Use appropriate system accounts and working directories, and review generated changes.
- Before exposing the service externally, complete administrator setup and configure HTTPS and access controls. Do not expose an unconfigured instance directly to the public internet.

## Development

After installing dependencies, start the development environment:

```sh
bun run dev:all
```

This command runs migrations and starts both the backend and frontend development servers. The default frontend port is `7778`, and the backend port is `7779`.

Common checks:

```sh
# Code style and static checks
bunx @biomejs/biome check .

# TypeScript type checking
bunx tsgo --noEmit

# Run tests in isolation
bun run test
```

When running a subset of tests, also use isolation mode: `bun test --isolate <test-file-path>`. See [Testing Guidelines](docs/TESTING.md) for testing conventions.

### Repository Structure

```text
frontend/         React frontend, workspace UI, and browser interactions
server/           HTTP / WebSocket services, agent framework, and business logic
shared/           Types and protocols shared by frontend and backend
remote-executor/  Remote execution devices
vscode-extension/ VS Code extension
scripts/          Development, build, and release scripts
```

The main technology stack includes Bun, TypeScript, React, Mantine, Hono, Drizzle ORM, and SQLite as the default storage backend.

### Contributing

Issues with bug reports, reproduction steps, and user feedback are welcome, as are Pull Requests improving code, tests, translations, and documentation.

- For significant features or architectural changes, discuss the scope and approach in an Issue first.
- When fixing a bug, provide reproduction steps and relevant tests whenever possible.
- When changing UI text, update both the English and Simplified Chinese translations.
- Remove API keys, access tokens, and other sensitive information before submitting logs, screenshots, or reproduction materials.
- Before a contribution can be merged, complete the signing and confirmation process in the [Contributor License Agreement (CLA)](CLA.md). Please read the full agreement first.

## Documentation

- [Testing Guidelines](docs/TESTING.md)
- [Knowledge Base and Permission Model](docs/KNOWLEDGE_BASE.md)
- [OAuth and External API](docs/OPEN_API.md)
- [VS Code Extension](docs/VSCODE_EXTENSION.md)
- [Model Provider Implementation Notes](docs/AGENT_PROVIDERS.md)
- [Third-Party License Notes](docs/LICENSES.md)

## License

NarraFork is licensed under the [Mozilla Public License 2.0 (MPL-2.0)](LICENSE), a **file-level weak copyleft** license:

- Use, modification, and commercial use are permitted.
- When distributing the software, MPL-covered files and their modifications must remain available as source under the MPL, with license and copyright notices preserved.
- MPL-covered files may be combined with independent files under other licenses; the entire project does not have to adopt the MPL.
- Internal use or modification without external distribution does not require publishing the modified source code.

This is a brief summary; the full license text governs. Third-party components follow their respective licenses. See [CLA.md](CLA.md) for the contributor agreement.
