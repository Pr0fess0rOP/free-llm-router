import { mkdir, writeFile } from "node:fs/promises";

const logos = [
  {
    name: "OpenRouter",
    slugs: ["openrouter"],
    file: "openrouter.svg",
    fallbackText: "O",
  },
  {
    name: "Groq",
    slugs: ["groq"],
    file: "groq.svg",
    fallbackText: "G",
  },
  {
    name: "NVIDIA",
    slugs: ["nvidia"],
    file: "nvidia.svg",
    fallbackText: "N",
  },
  {
    name: "Cerebras",
    slugs: ["cerebras"],
    file: "cerebras.svg",
    fallbackText: "C",
  },
  {
    name: "Mistral",
    slugs: ["mistralai", "mistral"],
    file: "mistral.svg",
    fallbackText: "M",
  },
  {
    name: "Aion Labs",
    slugs: ["aion"],
    file: "aion.svg",
    fallbackText: "A",
  },
  {
    name: "Z AI",
    slugs: ["zhipuai"],
    file: "z-ai.svg",
    fallbackText: "Z",
  },
  {
    name: "GitHub",
    slugs: ["github"],
    file: "github.svg",
    fallbackText: "G",
  },
  {
    name: "Hugging Face",
    slugs: ["huggingface"],
    file: "huggingface.svg",
    fallbackText: "H",
  },
  {
    name: "Kilo Code",
    slugs: ["kilocode"],
    file: "kilocode.svg",
    fallbackText: "K",
  },
  {
    name: "ModelScope",
    slugs: ["modelscope"],
    file: "modelscope.svg",
    fallbackText: "M",
  },
  {
    name: "SambaNova",
    slugs: ["sambanova"],
    file: "sambanova.svg",
    fallbackText: "S",
  },
  {
    name: "SiliconFlow",
    slugs: ["siliconflow"],
    file: "siliconflow.svg",
    fallbackText: "S",
  },
];

const outputDir = new URL("../public/logos/", import.meta.url);

await mkdir(outputDir, { recursive: true });

function fallbackSvg(label) {
  return `<svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="120" height="120" rx="28" fill="#E8F6EF"/>
  <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="Inter, Arial, sans-serif" font-size="54" font-weight="800" fill="#0F7B5F">${label}</text>
</svg>`;
}

async function tryDownload(slug) {
  const url = `https://cdn.jsdelivr.net/npm/simple-icons@v16/icons/${slug}.svg`;
  const response = await fetch(url);

  if (!response.ok) {
    return null;
  }

  return await response.text();
}

for (const logo of logos) {
  let svg = null;
  let usedSlug = null;

  for (const slug of logo.slugs) {
    try {
      svg = await tryDownload(slug);
      if (svg) {
        usedSlug = slug;
        break;
      }
    } catch {
      // Try next slug.
    }
  }

  if (!svg) {
    svg = fallbackSvg(logo.fallbackText);
    console.log(`Fallback created for ${logo.name} → public/logos/${logo.file}`);
  } else {
    console.log(`Downloaded ${logo.name} using "${usedSlug}" → public/logos/${logo.file}`);
  }

  await writeFile(new URL(logo.file, outputDir), svg, "utf8");
}