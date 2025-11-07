/**
 * Example configuration file for sync-worktrees
 *
 * This file demonstrates various ways to configure multiple repositories
 * for automatic Git worktree synchronization.
 */

import os from 'os';
import path from 'path';

export default {
  // Global defaults for all repositories (optional)
  defaults: {
    // Default cron schedule: every hour
    cronSchedule: "0 * * * *",
    // By default, run as a scheduled job (not one-time)
    runOnce: false,
    // Maximum age of branches to sync (optional)
    // branchMaxAge: "30d",  // Only sync branches active in last 30 days
    // Skip Git LFS downloads (optional)
    // skipLfs: true,  // Skip downloading large files tracked by Git LFS
    // Auto-update worktrees that are behind upstream (optional)
    // updateExistingWorktrees: true,  // Default: true, set to false to disable updates
  },
  
  // Retry configuration for handling transient errors (optional)
  retry: {
    maxAttempts: 'unlimited', // Maximum retry attempts ('unlimited' or number)
    maxLfsRetries: 2,         // Maximum retry attempts for LFS errors (default: 2)
    initialDelayMs: 1000,     // Initial delay: 1 second
    maxDelayMs: 600000,       // Maximum delay: 10 minutes
    backoffMultiplier: 2,     // Doubles delay each retry (1s, 2s, 4s, 8s...)
    jitterMs: 500             // Random jitter (0-500ms) to prevent thundering herd (default: 0)
  },

  // Simple retry presets (uncomment one):
  // retry: { maxAttempts: 5 },                    // Try 5 times then stop
  // retry: { maxAttempts: 'unlimited' },          // Keep trying forever
  // retry: { maxLfsRetries: 0 },                  // Don't retry LFS errors at all
  // retry: { maxDelayMs: 60000 },                 // Cap retry delay at 1 minute
  // retry: { initialDelayMs: 5000 },              // Start with 5 second delay
  // retry: { jitterMs: 1000 },                    // Add up to 1s random jitter for concurrent ops

  // Parallelism configuration for performance tuning (optional)
  parallelism: {
    maxRepositories: 10,      // Max concurrent repositories to sync (default: 10)
    maxWorktreeCreation: 1,   // Max concurrent worktree creations (default: 1 - KEEP LOW!)
    maxWorktreeUpdates: 3,    // Max concurrent worktree updates (default: 3)
    maxWorktreeRemoval: 3,    // Max concurrent worktree removals (default: 3)
    maxStatusChecks: 20       // Max concurrent status checks (default: 20)
  },

  // Performance tuning tips:
  // - maxWorktreeCreation: Keep at 1 to avoid Git lock contention issues
  // - maxStatusChecks: Safe to increase (20-50) since they're read-only
  // - maxWorktreeUpdates & maxWorktreeRemoval: Can safely increase to 5-10 on fast systems
  // - maxRepositories: Higher values speed up multi-repo syncs but use more resources
  // - Total concurrent operations = maxRepositories × per-repo limits (must be ≤ 100)
  // - On powerful machines with SSDs, you can increase these values for better performance
  // - Use jitterMs in retry config to prevent all concurrent operations from retrying at once
  // - Example safe config: maxRepositories=3, maxStatusChecks=20 = ~81 total operations
  
  // Array of repository configurations
  repositories: [
    {
      // Unique name for this repository configuration
      name: "my-main-project",
      
      // Git repository URL (required)
      repoUrl: "https://github.com/user/my-main-project.git",
      
      // Directory where worktrees will be created
      worktreeDir: path.join(os.homedir(), "projects", "my-main-project-worktrees"),
      
      // Override default schedule for this repo (every 15 minutes)
      cronSchedule: "*/15 * * * *"
    },
    
    {
      name: "work-project",
      
      // Using environment variables for sensitive data
      repoUrl: process.env.WORK_REPO_URL || "git@github.com:company/work-project.git",
      
      // Relative paths are resolved from the config file location
      worktreeDir: "./worktrees/work-project",
      
      // Only sync during business hours on weekdays
      cronSchedule: "0 9-17 * * 1-5"
    },
    
    {
      name: "documentation",
      
      repoUrl: "https://github.com/user/documentation.git",
      worktreeDir: "/home/user/docs/docs-worktrees",
      
      // Uses global defaults for cronSchedule and runOnce
    },
    
    {
      name: "experimental-features",

      repoUrl: "https://github.com/user/experimental.git",
      worktreeDir: path.join(os.homedir(), "experiments", "worktrees"),

      // Custom bare repository location
      bareRepoDir: path.join(os.homedir(), "experiments", ".bare", "experimental"),

      // This repo should only sync when manually triggered
      runOnce: true,

      // Repository-specific retry configuration (overrides global)
      retry: {
        maxAttempts: 10,        // Try 10 times for experimental repo
        initialDelayMs: 2000    // Start with 2 second delay
      },

      // Repository-specific parallelism configuration (overrides global)
      parallelism: {
        maxStatusChecks: 50,    // This repo has many branches, check them faster
        maxWorktreeUpdates: 5   // Can handle more concurrent updates
      }
    },
    
    {
      name: "active-development",
      
      repoUrl: "https://github.com/user/active-dev.git",
      worktreeDir: "./worktrees/active-dev",
      
      // Only sync branches that have been active in the last 2 weeks
      branchMaxAge: "14d",
      
      // Check for updates every 30 minutes
      cronSchedule: "*/30 * * * *"
    },
    
    {
      name: "legacy-project",
      
      repoUrl: "https://github.com/user/legacy.git",
      worktreeDir: "./worktrees/legacy",
      
      // For legacy projects, only sync branches active in last 6 months
      branchMaxAge: "6m",
      
      // Check less frequently - once per day
      cronSchedule: "0 0 * * *"
    },
    
    {
      name: "large-media-project",
      
      repoUrl: "https://github.com/user/large-media.git",
      worktreeDir: "./worktrees/large-media",
      
      // Skip downloading LFS files to save bandwidth and disk space
      skipLfs: true,
      
      // Still check regularly for code changes
      cronSchedule: "0 * * * *"
    },
    
    {
      name: "read-only-reference",
      
      repoUrl: "https://github.com/user/reference.git",
      worktreeDir: "./worktrees/reference",
      
      // Disable automatic updates for read-only reference repositories
      updateExistingWorktrees: false,
      
      // Check less frequently since we won't update
      cronSchedule: "0 0 * * 0"  // Once per week
    }
  ]
};

// Advanced example: Dynamic configuration based on environment
/*
const isDevelopment = process.env.NODE_ENV === 'development';

export default {
  defaults: {
    cronSchedule: isDevelopment ? "*\/5 * * * *" : "0 * * * *",
    runOnce: false
  },

  repositories: [
    // Filter repositories based on environment
    ...(isDevelopment ? [{
      name: "dev-only-repo",
      repoUrl: "https://github.com/user/dev-repo.git",
      worktreeDir: "./dev/worktrees"
    }] : []),

    // Always include production repos
    {
      name: "production-app",
      repoUrl: process.env.PROD_REPO_URL,
      worktreeDir: "/var/apps/production-worktrees",
      cronSchedule: "0 *\/6 * * *"  // Every 6 hours
    }
  ]
};
*/