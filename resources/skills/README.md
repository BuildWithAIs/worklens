# Built-in skills

Each subdirectory containing `SKILL.md` ships via `extraResources` and is
resynced into `~/.worklens/skills` on app launch. Edit the source here;
user copies of bundled skills are replaced on the next launch.
Local skills in `~/.agents/skills` are read only and never deleted or overwritten.

`tavily-research` is WorkLens-authored guidance for its connector to the official
Tavily Research API. It is not an upstream Tavily skill.

Settings and the agent use the same built-in-first precedence for duplicate
names. A shadowed local skill is shown as inactive and can still be revealed.
Disabling the winning skill does not silently enable its shadowed counterpart.
Refresh rescans the folders and applies changes on the next conversation turn;
it does not retract instructions already read in the current turn.
