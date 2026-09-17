# Built-in skills

Each subdirectory containing `SKILL.md` ships via `extraResources` and is
resynced into `~/.worklens/skills` on app launch. Edit the source here;
user copies of bundled skills are replaced on the next launch.
Local skills in `~/.agents/skills` are read only and never deleted or overwritten.

No skills are currently bundled. Keep this resource directory for future built-in
skills; the loading, settings, and invocation mechanisms remain available.

Settings and the agent use the same built-in-first precedence for duplicate
names. A shadowed local skill is shown as inactive and can still be revealed.
Disabling the winning skill does not silently enable its shadowed counterpart.
Refresh rescans the folders and applies changes on the next conversation turn;
it does not retract instructions already read in the current turn.

Before each conversation turn (including the first turn of a new session),
WorkLens rescans the two sources and resolves the current settings into one
snapshot for Pi. Only enabled, non-shadowed skills are supplied to Pi. Toggle
preferences use source + file path identities, so editing a skill's `name`
does not reset its switch. Moving a skill to a new path creates a new identity.
Legacy name-based preferences are migrated when matching files are discovered.
Each file retains its own preference if a higher-priority version is removed.

In chat, type `/` to choose an enabled skill or enter `/skill:name your task`.
Pi expands the selected skill's instructions into the model's context; the
conversation displays the command. Ordinary skills also remain available for
automatic, on-demand use. Skills with `disable-model-invocation: true` can only
be invoked explicitly and are omitted from the system prompt's catalog.
Disabled skills cannot be invoked with a slash command.
