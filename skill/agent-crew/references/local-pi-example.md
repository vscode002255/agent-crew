# Local Pi setup

Use the Pi CLI's JavaScript entry directly. This keeps argv execution free of
shell wrappers and works with `spawn(..., { shell: false })`.

On Windows, resolve the entry with:

```powershell
$piEntry = Join-Path (npm root -g) "@earendil-works/pi-coding-agent/dist/bundle/cli.js"
```

Register Pi as a worker:

```powershell
$prompt = @'
Implement only the assigned task. Respect the declared write scopes. Report
changed files, commands, tests, and limitations. Do not claim acceptance.
'@

$command = @(
  "node",
  $piEntry,
  "--offline",
  "--approve",
  "--no-extensions",
  "--no-mcp",
  "--no-skills",
  "--tools", "read,write,edit,bash,powershell,ls",
  "-p", $prompt
) | ConvertTo-Json -Compress

node crew.js agent add `
  --root "D:\project" `
  --id pi-worker `
  --label "Local Pi" `
  --role implementer `
  --command-json $command `
  --timeout 900
```

Create a task with an independent acceptance command:

```powershell
$accept = @(
  "node", "--test"
) | ConvertTo-Json -Compress

node crew.js task add `
  --root "D:\project" `
  --id implement `
  --title "Implement the requested feature" `
  --assignee pi-worker `
  --writes src `
  --accept-json $accept `
  --accept-timeout 120
```

Run, verify, and sign off:

```powershell
node crew.js run --root "D:\project" --max-parallel 2 --json
node crew.js verify --root "D:\project" implement
node crew.js accept --root "D:\project" implement `
  --note "Independent tests passed and diff reviewed" `
  --evidence test-output.txt
```

Use `node <pi-entry>` rather than `pi.cmd` or `pi.ps1`: the wrappers require a
shell, while the Node entry can be spawned as a literal argv array.
