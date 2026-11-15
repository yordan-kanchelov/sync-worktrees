---
"sync-worktrees": patch
---

Empty or manifest-less trash containers left behind by an interrupted removal (holding nothing, or only temporary files) were warned about forever and never cleaned up. The trash reaper now removes them; manifest-less directories with any other content are still left alone.
