import { PacketWriter } from "../network/PacketWriter";
import { PlayOut } from "./packetIds";

export function experience(progress: number, level: number, totalExperience = 0): PacketWriter {
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) throw new RangeError("Experience progress must be between 0 and 1");
  for (const value of [level, totalExperience]) {
    if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff) throw new RangeError("Experience counts must be nonnegative signed integers");
  }
  return new PacketWriter(PlayOut.Experience).writeFloat(progress).writeVarInt(level).writeVarInt(totalExperience);
}

/** Blank number format suppresses the score numbers in a sidebar. */
export function scoreboardObjective(name: string, action: 0 | 1 | 2, title = ""): PacketWriter {
  const packet = new PacketWriter(PlayOut.ScoreboardObjective).writeString(name).writeByte(action);
  if (action !== 1) packet.writeTextComponent({ text: title }).writeVarInt(0).writeBoolean(true).writeVarInt(0);
  return packet;
}

export function displayObjective(name: string): PacketWriter {
  return new PacketWriter(PlayOut.DisplayObjective).writeVarInt(1).writeString(name);
}

export function scoreboardScore(objective: string, entry: string, score: number, text: string): PacketWriter {
  return new PacketWriter(PlayOut.ScoreboardScore).writeString(entry).writeString(objective).writeVarInt(score)
    .writeBoolean(true).writeTextComponent({ text }).writeBoolean(true).writeVarInt(0);
}

export function resetScore(objective: string, entry: string): PacketWriter {
  return new PacketWriter(PlayOut.ResetScore).writeString(entry).writeBoolean(true).writeString(objective);
}
