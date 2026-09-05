import { GeistSans } from "geist/font/sans";
import { GeistPixelSquare } from "geist/font/pixel";
import { Handjet } from "next/font/google";

const handjet = Handjet({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-handjet",
});

export const fontVariablesClassName = `${GeistSans.variable} ${GeistPixelSquare.variable} ${handjet.variable}`;
