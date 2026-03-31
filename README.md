# sur-node — AI Memory for Claude

sur-node gives Claude a persistent memory that works across every conversation, every device, every restart. When Claude runs `sur_snap`, it saves a summary to your hard drive with a unique ID (a hash). Next session, paste that hash and Claude picks up exactly where it left off.

Two editions:

- **SurStor Personal** — local DLFS-backed storage, single node, works standalone
- **SurStor Grid** — same interface, but link records replicate across the Covia distributed venue network (set `COVIA_URL` to activate)

Three pieces work together:

- **DLFS** — a small Java server that stores your artifacts as files on your hard drive
- **sur-node** — connects DLFS to Claude via MCP so Claude can save and retrieve things for you
- **Covia venue** — optional Grid backend for distributed replication (SurStor Grid only)

---

## What You Need

Install these first. Each link takes you to the official download page.

| Tool | Why | Download |
|------|-----|----------|
| **Java 11+** | Runs the DLFS storage server | https://adoptium.net — click "Latest LTS Release" |
| **Node.js 18+** | Runs the sur-node MCP server | https://nodejs.org — click "LTS" |
| **Claude Code** | The AI you're connecting this to | https://claude.ai/code |

To check if you already have them, open a terminal and run:
```
java -version
node --version
```
If both print a version number, you're good.

---

## Step 1: Get the Files

Download and unzip the sur-node package to a permanent location on your computer. A good spot:

- **Windows:** `C:\Users\YourName\sur-node\`
- **Mac/Linux:** `~/sur-node/`

The folder should contain:
```
sur-node/
  index.js
  package.json
  dlfs/
    deps/          ← all the .jar files go here
  start-dlfs.ps1   ← Windows startup script
  start-dlfs.sh    ← Mac/Linux startup script
```

Then install dependencies (do this once):
```
cd sur-node
npm install
```

---

## Step 2: Connect to Claude Code

Run this command once, substituting the actual path to your `sur-node` folder:

**Windows:**
```
claude mcp add surstor -- node C:\Users\YourName\sur-node\index.js
```

**Mac/Linux:**
```
claude mcp add surstor -- node /home/yourname/sur-node/index.js
```

To confirm it worked:
```
claude mcp list
```
You should see `surstor` with a green checkmark.

---

## Step 3: Start DLFS

DLFS is the storage server that runs in the background. You need to start it before using Claude.

### Windows

Double-click `start-dlfs.ps1`, or run it from PowerShell:
```
powershell -ExecutionPolicy Bypass -File C:\Users\YourName\sur-node\start-dlfs.ps1
```

### Mac / Linux

Make the script executable once:
```
chmod +x ~/sur-node/start-dlfs.sh
```

Then start it:
```
~/sur-node/start-dlfs.sh
```

### Test that DLFS is running

Open a browser and go to: `http://localhost:8765/dlfs/`

You should see a simple directory listing (WebDAV). If you get an error, DLFS isn't running yet.

---

## Step 4: Make DLFS Start Automatically

You don't want to remember to start DLFS every time you reboot. Set it up once and it runs automatically on login.

### Windows (Startup Folder — no admin required)

1. Press `Win + R`, type `shell:startup`, press Enter
2. Create a file called `start-dlfs.bat` in that folder with this content:
   ```
   @echo off
   powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\Users\YourName\sur-node\start-dlfs.ps1"
   ```
3. Done. DLFS will start silently in the background every time you log in.

### Mac (launchd)

1. Create the file `~/Library/LaunchAgents/world.surstor.dlfs.plist` with this content
   (replace `/Users/yourname/sur-node` with your actual path):

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
     "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key>
     <string>world.surstor.dlfs</string>
     <key>ProgramArguments</key>
     <array>
       <string>/bin/bash</string>
       <string>/Users/yourname/sur-node/start-dlfs.sh</string>
     </array>
     <key>RunAtLoad</key>
     <true/>
     <key>KeepAlive</key>
     <false/>
     <key>StandardOutPath</key>
     <string>/Users/yourname/sur-node/dlfs.log</string>
     <key>StandardErrorPath</key>
     <string>/Users/yourname/sur-node/dlfs-err.log</string>
   </dict>
   </plist>
   ```

2. Load it now (no reboot needed):
   ```
   launchctl load ~/Library/LaunchAgents/world.surstor.dlfs.plist
   ```

3. Done. DLFS will start automatically on every login.

### Linux (systemd)

1. Create the file `~/.config/systemd/user/dlfs.service` with this content
   (replace `/home/yourname/sur-node` with your actual path):

   ```ini
   [Unit]
   Description=SurStor DLFS Server
   After=network.target

   [Service]
   ExecStart=/bin/bash /home/yourname/sur-node/start-dlfs.sh
   Restart=no
   StandardOutput=append:/home/yourname/sur-node/dlfs.log
   StandardError=append:/home/yourname/sur-node/dlfs-err.log

   [Install]
   WantedBy=default.target
   ```

2. Enable and start it:
   ```
   systemctl --user enable dlfs
   systemctl --user start dlfs
   ```

3. Allow user services to run without being logged in (do once):
   ```
   loginctl enable-linger $USER
   ```

---

## Step 5: Test the Full Stack

Start a Claude Code session and try:

```
sur_list
```

If you see a list of artifacts (or an empty list with no error), everything is working.

Then try saving something:
```
sur_store("Hello from my first session", label: "test-hello", tags: ["test"])
```

You'll get back a hash like `sha256:abc123...`. Paste that hash into any future Claude session and Claude can retrieve exactly what you stored.

---

## Where Your Data Lives

All artifacts are stored as plain files on your computer:

- **Mac/Linux:** `~/.convex/dlfs/`
- **Windows:** `C:\Users\YourName\.convex\dlfs\`

Nothing is sent to the cloud. You own it.

---

## Troubleshooting

**"DLFS not running" or connection error in Claude**
- Check `http://localhost:8765/dlfs/` in your browser
- If blank/error: start DLFS manually using the script above
- Check `dlfs-err.log` in your sur-node folder for error messages

**sur-node shows as disconnected in `claude mcp list`**
- Make sure DLFS is running first, then restart Claude Code

**"Access denied" running the .ps1 on Windows**
- Right-click PowerShell → "Run as Administrator", then run the script once to unblock it
- Or: open PowerShell and run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

**Rebuilt a new machine and lost your artifacts**
- Your data is in `~/.convex/dlfs/` — copy that folder to the new machine
- Then run `sur_rebuild` in Claude to re-sync the index

---

## How It Works (the short version)

When Claude calls `sur_snap`, sur-node:
1. Takes the conversation summary you provide
2. Computes a SHA-256 hash of the content
3. Stores the content as a file in DLFS (`~/.convex/dlfs/artifacts/`)
4. Stores the metadata (label, tags, date) alongside it
5. Returns the hash

The hash is the identity. Same content always produces the same hash. Give that hash to any Claude session on any machine with sur-node installed and it retrieves the exact same artifact.
