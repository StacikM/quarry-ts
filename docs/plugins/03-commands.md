# 3. Commands and operator permissions

[Back to the index](README.md)

`api.registerCommand()` returns `false` if a case-insensitive name is already registered. The first command wins, including core commands. Throw during enable if your plugin needs a command that it could not register; the manager removes its partial registrations. `usage` is descriptive text: your handler validates arguments and sends usage messages itself.

```js
module.exports = {
  name: "guide-notice",
  version: "1.0.0",
  onEnable(api) {
    const registered = api.registerCommand({
      name: "notice",
      description: "Broadcast an operator notice",
      usage: "/notice <message>",
      opOnly: true,
      run(player, args) {
        if (!args.length) { player.sendMessage("Usage: /notice <message>", "red"); return; }
        api.server.broadcastMessage(`[Notice] ${args.join(" ")}`, "gold");
      },
    });
    if (!registered) throw new Error("/notice is already registered");
  },
};
```

## From the console

A command can also be run from the server console: add an optional `runConsole(sender, args)` next to `run(player, args)`. `sender` has `name`, `isOp`, `isConsole`, `server` and `sendMessage(text)`, and a `Player` fits that shape too, so the same function can serve both. Commands without `runConsole` are game only, and the console says so. The built-in `/kick`, `/ban`, `/whitelist`, `/tps` and others work this way.

## Permissions

`opOnly` checks `player.isOp`, based on the case-insensitive names in `ops.json` (loaded into `config.ops`). Omit it for a public command. `/help` lists public commands and hides operator commands from non-operators. These permissions do not authenticate usernames: this server currently runs in offline mode.


## Commands that come with the server

| Command | Who | What it does |
| --- | --- | --- |
| `/help`, `/list`, `/seed`, `/plugins`, `/spawn` | everyone | Information and going to spawn |
| `/gamemode <mode>`, `/tp <player>` | operators | Game mode and teleporting |
| `/whitelist on\|off\|add\|remove\|list\|reload` | operators, console | The whitelist |
| `/kick`, `/ban`, `/unban`, `/banip`, `/unbanip`, `/banlist` | operators, console | Moderation |
| `/op`, `/deop`, `/ops`, `/say`, `/save`, `/mem`, `/perf` | operators, console | Running the server |
| `/tps` | everyone, console | Tick rate and stalls |
