# Implementation Plan: Interactive UI with Ink

## Branch: feat/add-interactive-ui-ink

## Goal
Add an interactive terminal UI to sync-worktrees using [ink](https://github.com/vadimdemedes/ink) - a React-based framework for building terminal applications.

## Why Ink?
- ✅ **Modern & Maintained**: Active development, part of React ecosystem
- ✅ **React-based**: Component architecture, familiar patterns
- ✅ **Type-safe**: Full TypeScript support
- ✅ **Powerful**: Flexbox layouts, hooks, and rich component library
- ✅ **Better than blessed**: More maintainable, better developer experience

## Features to Implement

### 1. Real-time Interactive UI
- Live status display showing:
  - Current sync status (Running/Syncing)
  - Repository count
  - Last sync time
  - Next scheduled sync time
- Scrollable log output with color-coded messages
  - Info messages (default)
  - Warning messages (yellow)
  - Error messages (red)
- Help modal with keyboard shortcuts

### 2. Keyboard Controls
- `?` or `h` - Toggle help screen
- `s` - Manually trigger sync for all repositories
- `r` - Reload configuration and re-sync all repos
- `q` or `Ctrl+C` - Gracefully quit

### 3. Console Redirection
- Redirect console.log/error/warn to UI log panel
- Preserve original stdout/stderr for external logging systems
- Format and colorize output appropriately

### 4. Cron Integration
- Display next sync time based on cron schedule
- Update status after each sync

## Implementation Steps

### Phase 1: Setup & Dependencies ✅ NEXT
- [ ] Install ink, React, and dependencies
- [ ] Update TypeScript configuration for React/JSX
- [ ] Configure Jest for React component testing
- [ ] Update package.json scripts

### Phase 2: Core Components
- [ ] Create `src/components/App.tsx` - Main UI component
  - Status bar component
  - Log display component
  - Help modal component
  - Footer/help bar component
- [ ] Create `src/components/StatusBar.tsx` - Status display
- [ ] Create `src/components/LogViewer.tsx` - Scrollable log
- [ ] Create `src/components/HelpModal.tsx` - Help screen

### Phase 3: Service Layer
- [ ] Create `src/services/InteractiveUIService.tsx`
  - Manage UI state
  - Handle keyboard input
  - Redirect console output
  - Integrate with WorktreeSyncService
  - Manage sync operations
- [ ] Console redirection utilities
- [ ] Cron schedule calculation

### Phase 4: Integration
- [ ] Update `src/index.ts` to use InteractiveUIService
- [ ] Handle single repo mode
- [ ] Handle multi-repo mode from config
- [ ] Graceful shutdown and cleanup

### Phase 5: Testing
- [ ] Unit tests for InteractiveUIService
- [ ] Component tests using ink-testing-library
- [ ] Integration tests with WorktreeSyncService
- [ ] Manual testing with real repositories

### Phase 6: Documentation
- [ ] Update README with interactive UI features
- [ ] Add screenshots/demo GIF
- [ ] Document keyboard shortcuts
- [ ] Update CLAUDE.md

## Technical Considerations

### Dependencies
```json
{
  "dependencies": {
    "ink": "^5.x",
    "react": "^19.x",
    "cron-parser": "^5.x"
  },
  "devDependencies": {
    "@types/react": "^19.x",
    "ink-testing-library": "^4.x"
  }
}
```

### TypeScript Config
```json
{
  "compilerOptions": {
    "jsx": "react",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true
  }
}
```

### File Structure
```
src/
├── components/
│   ├── App.tsx              # Main UI component
│   ├── StatusBar.tsx        # Status display
│   ├── LogViewer.tsx        # Log output
│   └── HelpModal.tsx        # Help screen
├── services/
│   └── InteractiveUIService.tsx
├── __tests__/
│   ├── components/
│   │   └── App.test.tsx
│   └── services/
│       └── interactive-ui.service.test.tsx
└── index.ts
```

## API Compatibility

The InteractiveUIService should maintain the same public API as the blessed version:

```typescript
class InteractiveUIService {
  constructor(
    syncServices: WorktreeSyncService[],
    configPath?: string,
    cronSchedule?: string
  )

  public log(message: string): void
  public updateLastSyncTime(): void
  public destroy(): void
}
```

## Success Criteria

- [ ] All keyboard shortcuts work as expected
- [ ] UI updates in real-time during sync operations
- [ ] Console output is properly redirected and formatted
- [ ] Help modal displays correctly
- [ ] Graceful shutdown with Ctrl+C
- [ ] All tests pass (existing + new)
- [ ] No regressions in non-UI functionality
- [ ] Works with both single and multi-repository modes

## Migration Notes

This is a **new implementation** from scratch, not a migration from the blessed version. The blessed-based PR (`feat/add-interactive-ui`) can be:
- Closed/abandoned (preferred - cleaner git history)
- Kept as reference
- Merged separately if desired (though this ink version supersedes it)

## Timeline Estimate

- Phase 1 (Setup): 30 minutes
- Phase 2 (Components): 2-3 hours
- Phase 3 (Service): 2-3 hours
- Phase 4 (Integration): 1 hour
- Phase 5 (Testing): 2-3 hours
- Phase 6 (Documentation): 1 hour

**Total: ~8-12 hours of development time**

## Resources

- [Ink Documentation](https://github.com/vadimdemedes/ink)
- [Ink Examples](https://github.com/vadimdemedes/ink/tree/master/examples)
- [ink-testing-library](https://github.com/vadimdemedes/ink-testing-library)
- Original blessed implementation (for feature reference)

---

**Status**: 🟡 Planning Complete - Ready to implement
**Last Updated**: 2025-11-02
