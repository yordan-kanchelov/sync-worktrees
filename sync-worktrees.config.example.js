/**
 * Example configuration file for sync-worktrees
 * 
 * This file demonstrates various ways to configure multiple repositories
 * for automatic Git worktree synchronization.
 */

const os = require('os');
const path = require('path');

module.exports = {
  // Global defaults for all repositories (optional)
  defaults: {
    // Default cron schedule: every hour
    cronSchedule: "0 * * * *",
    // By default, run as a scheduled job (not one-time)
    runOnce: false
  },
  
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
      runOnce: true
    }
  ]
};

// Advanced example: Dynamic configuration based on environment
/*
const isDevelopment = process.env.NODE_ENV === 'development';

module.exports = {
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