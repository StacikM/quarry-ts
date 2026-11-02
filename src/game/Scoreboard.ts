import type { PacketWriter } from "../network/PacketWriter";
import { displayObjective, resetScore, scoreboardObjective, scoreboardScore } from "../protocol/lobbyPackets";

/** Per-player sidebar. Stable entry IDs allow duplicate text and blank lines. */
export class Scoreboard {
  private active = false;
  private title = "";
  private lines: string[] = [];
  private readonly objective = "quarry_sidebar";

  constructor(private readonly player: { send(packet: PacketWriter): void }) {}

  /** Lines are displayed top to bottom; Minecraft supports at most 15. */
  set(title: string, lines: readonly string[]): void {
    if (lines.length > 15) throw new RangeError("A sidebar supports at most 15 lines");
    if (!this.active || title !== this.title) this.player.send(scoreboardObjective(this.objective, this.active ? 2 : 0, title));
    for (let i = lines.length; i < this.lines.length; i++) this.player.send(resetScore(this.objective, `line_${i}`));
    lines.forEach((text, i) => {
      if (!this.active || text !== this.lines[i]) this.player.send(scoreboardScore(this.objective, `line_${i}`, 15 - i, text));
    });
    if (!this.active) this.player.send(displayObjective(this.objective));
    this.active = true;
    this.title = title;
    this.lines = [...lines];
  }

  clear(): void {
    if (!this.active) return;
    this.player.send(displayObjective(""));
    this.player.send(scoreboardObjective(this.objective, 1));
    this.active = false;
    this.lines = [];
  }
}
