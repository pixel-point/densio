import { readFile } from "fs/promises";
import { extname, join } from "path";
import { ImageResponse } from "next/og";
import config from "@/configs/website-config";

export const SOCIAL_IMAGE_SIZE = {
  width: 1200,
  height: 630,
} as const;

export const SOCIAL_IMAGE_CONTENT_TYPE = "image/png";

type CreateSocialImageOptions = {
  title?: string;
  size?: {
    width: number;
    height: number;
  };
};

type HomePageData = {
  metadata?: {
    title?: string;
  };
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readTextFile(relativePath: string): Promise<string | null> {
  try {
    return await readFile(join(process.cwd(), relativePath), "utf-8");
  } catch {
    return null;
  }
}

async function readJsonFile<T>(relativePath: string): Promise<T | null> {
  const content = await readTextFile(relativePath);
  if (!content) return null;

  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function getCssBlock(cssText: string, selector: string): string | null {
  const blockMatch = cssText.match(
    new RegExp(`${escapeRegExp(selector)}\\s*\\{([\\s\\S]*?)\\}`, "m"),
  );
  return blockMatch?.[1] ?? null;
}

function getCssVariable(cssBlock: string | null, variableName: string): string | null {
  if (!cssBlock) return null;

  const tokenMatch = cssBlock.match(
    new RegExp(`${escapeRegExp(variableName)}\\s*:\\s*([^;]+);?`, "i"),
  );
  return tokenMatch?.[1]?.trim() ?? null;
}

function normalizeCssColor(value: string | null | undefined): string | null {
  if (!value) return null;

  const normalized = value.trim();
  if (!normalized.length) return null;
  if (/^(#|rgb\(|rgba\(|hsl\(|hsla\()/i.test(normalized)) {
    return normalized;
  }

  return `hsl(${normalized})`;
}

async function resolveThemeColors(): Promise<{ background: string; foreground: string }> {
  const globalsCss = await readTextFile("src/styles/globals.css");
  const cssBlock = globalsCss ? getCssBlock(globalsCss, ":root") : null;
  const background =
    normalizeCssColor(getCssVariable(cssBlock, "--background")) ?? config.metaThemeColor;
  const foreground = normalizeCssColor(getCssVariable(cssBlock, "--foreground")) ?? "#09090b";

  return { background, foreground };
}

function resolveContentType(assetPath: string): string {
  switch (extname(assetPath).toLowerCase()) {
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

async function readPublicAssetAsDataUrl(assetPath: string): Promise<string | null> {
  const relativePath = assetPath.replace(/^\/+/, "");

  try {
    const buffer = await readFile(join(process.cwd(), "public", relativePath));
    return `data:${resolveContentType(assetPath)};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

function getFallbackBrandText(): string {
  const trimmedName = config.projectName.trim();
  return trimmedName.length ? trimmedName.slice(0, 1).toUpperCase() : "P";
}

export async function resolveHomeSocialTitle(): Promise<string> {
  const homeData = await readJsonFile<HomePageData>("src/components/pages/home/data.json");
  const title = homeData?.metadata?.title;

  return typeof title === "string" && title.trim().length > 0 ? title.trim() : "Home";
}

export async function createSocialImageResponse({
  title,
  size = SOCIAL_IMAGE_SIZE,
}: CreateSocialImageOptions): Promise<ImageResponse> {
  const { background, foreground } = await resolveThemeColors();
  const logoDataUrl = await readPublicAssetAsDataUrl(config.logo);
  const resolvedTitle = title?.trim() || config.projectName;

  return new ImageResponse(
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "56px",
        background,
        color: foreground,
      }}
    >
      {logoDataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoDataUrl}
          alt={config.logoAlt || config.projectName}
          height={40}
          style={{
            objectFit: "contain",
            objectPosition: "left center",
            width: "auto",
          }}
        />
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "24px",
            border: `2px solid ${foreground}`,
            padding: "18px 24px",
            fontSize: "36px",
            fontWeight: 700,
          }}
        >
          {getFallbackBrandText()}
        </div>
      )}

      <div
        style={{
          display: "flex",
          maxWidth: "92%",
          fontSize: "78px",
          fontWeight: 700,
          lineHeight: 1.04,
          letterSpacing: "-0.06em",
        }}
      >
        {resolvedTitle}
      </div>
    </div>,
    {
      width: size.width,
      height: size.height,
    },
  );
}
