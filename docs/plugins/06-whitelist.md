# 6. Whitelist

[Back to the index](README.md)

Use `/whitelist on|off|add <name>|remove <name>|list|reload` as an operator, or the same command without a slash in the console. Names are case-insensitive. Operators bypass the whitelist, but bans are always checked first.

Successful changes immediately kick online non-listed non-operators and report the count. `whitelist.json` is private and stores `{ "enabled": false, "names": [] }`. Its flag survives restarts. The installer/panel can force the whitelist on at startup with `server.json` `"whitelist": true` or `QUARRY_WHITELIST=true`; false or absent preserves the saved flag. Remove a forced-on startup setting if you want `/whitelist off` to survive a restart.

Invalid individual names are skipped with a warning. A malformed or unreadable document keeps existing in-memory rules and fails closed for unlisted new logins; operators can log in to repair it. Missing files during reload do not silently disable an active whitelist. Because this server is offline mode, these name-based checks do not authenticate account ownership.
