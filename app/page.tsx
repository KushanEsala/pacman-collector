import type { Metadata } from "next";
import { GameCollector } from "./GameCollector";

export const metadata: Metadata = {
  title: "Pac-Man DDA Player Study",
  description: "Play five short rounds and contribute anonymous gameplay feedback to a dynamic difficulty research project.",
};

export default function Home() {
  return <GameCollector />;
}
