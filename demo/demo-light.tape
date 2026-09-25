# sync-worktrees demo, light theme. Render both themes from the repository root with:
#
#   pnpm build && demo/render.sh
#
# demo.tape is the dark twin (which also renders the site video); keep the settings in step.
# The storyboard itself lives in story.tape.

Output assets/demo-light.gif

Require sync-worktrees
Require tree

Set Shell "bash"
Set FontFamily "JetBrains Mono"
Set FontSize 18
Set LineHeight 1.2
Set Width 1000
Set Height 700
Set Padding 24
Set Margin 0
Set WindowBar Colorful
Set BorderRadius 8
Set Framerate 15
Set TypingSpeed 22ms
Set Theme "Catppuccin Latte"

Source demo/story.tape

