import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Dynamic color in range 100-150
let currentColor: [number, number, number] = [150, 130, 0];

function randomColor(): [number, number, number] {
	return [
		Math.floor(Math.random() * 51) + 100,
		Math.floor(Math.random() * 51) + 100,
		Math.floor(Math.random() * 51) + 100,
	] as [number, number, number];
}

function brighten(rgb: [number, number, number], factor: number): string {
	const [r, g, b] = rgb.map((c) => Math.round(c + (255 - c) * factor));
	return `\x1b[38;2;${r};${g};${b}m`;
}

function colorize(text: string, shinePos: number): string {
	return (
		[...text]
			.map((c, i) => {
				let factor = 0;
				if (shinePos >= 0) {
					const dist = Math.abs(i - shinePos);
					if (dist === 0) factor = 0.7;
					else if (dist === 1) factor = 0.35;
				}
				return `${brighten(currentColor, factor)}${c}`;
			})
			.join("") + "\x1b[0m"
	);
}

let currentVerb = "";
let animationFrame = 0;
let animationTimer: ReturnType<typeof setInterval> | undefined;

function startRainbowAnimation(ctx: Parameters<ExtensionAPI>[0]["on"]["turn_start"]): void {
	if (animationTimer) return;
	animationTimer = setInterval(() => {
		animationFrame++;
		const cycle = animationFrame % 20;
		const shinePos = cycle < 10 ? cycle : -1;
		const rainbowVerb = colorize(currentVerb + "...", shinePos);
		ctx.ui.setWorkingMessage(`${rainbowVerb}`);
	}, 60);
}

function stopRainbowAnimation(): void {
	if (animationTimer) {
		clearInterval(animationTimer);
		animationTimer = undefined;
	}
}
const SPINNER_VERBS = [
  'Accomplishing',
  'Actioning',
  'Actualizing',
  'Architecting',
  'Baking',
  'Beaming',
  "Beboppin'",
  'Befuddling',
  'Billowing',
  'Blanching',
  'Bloviating',
  'Boogieing',
  'Boondoggling',
  'Booping',
  'Bootstrapping',
  'Brewing',
  'Bunning',
  'Burrowing',
  'Calculating',
  'Canoodling',
  'Caramelizing',
  'Cascading',
  'Catapulting',
  'Cerebrating',
  'Channeling',
  'Channelling',
  'Choreographing',
  'Churning',
  'Clauding',
  'Coalescing',
  'Cogitating',
  'Combobulating',
  'Composing',
  'Computing',
  'Concocting',
  'Considering',
  'Contemplating',
  'Cooking',
  'Crafting',
  'Creating',
  'Crunching',
  'Crystallizing',
  'Cultivating',
  'Deciphering',
  'Deliberating',
  'Determining',
  'Dilly-dallying',
  'Discombobulating',
  'Doing',
  'Doodling',
  'Drizzling',
  'Ebbing',
  'Effecting',
  'Elucidating',
  'Embellishing',
  'Enchanting',
  'Envisioning',
  'Evaporating',
  'Fermenting',
  'Fiddle-faddling',
  'Finagling',
  'Flambéing',
  'Flibbertigibbeting',
  'Flowing',
  'Flummoxing',
  'Fluttering',
  'Forging',
  'Forming',
  'Frolicking',
  'Frosting',
  'Gallivanting',
  'Galloping',
  'Garnishing',
  'Generating',
  'Gesticulating',
  'Germinating',
  'Gitifying',
  'Grooving',
  'Gusting',
  'Harmonizing',
  'Hashing',
  'Hatching',
  'Herding',
  'Honking',
  'Hullaballooing',
  'Hyperspacing',
  'Ideating',
  'Imagining',
  'Improvising',
  'Incubating',
  'Inferring',
  'Infusing',
  'Ionizing',
  'Jitterbugging',
  'Julienning',
  'Kneading',
  'Leavening',
  'Levitating',
  'Lollygagging',
  'Manifesting',
  'Marinating',
  'Meandering',
  'Metamorphosing',
  'Misting',
  'Moonwalking',
  'Moseying',
  'Mulling',
  'Mustering',
  'Musing',
  'Nebulizing',
  'Nesting',
  'Newspapering',
  'Noodling',
  'Nucleating',
  'Orbiting',
  'Orchestrating',
  'Osmosing',
  'Perambulating',
  'Percolating',
  'Perusing',
  'Philosophising',
  'Photosynthesizing',
  'Pollinating',
  'Pondering',
  'Pontificating',
  'Pouncing',
  'Precipitating',
  'Prestidigitating',
  'Processing',
  'Proofing',
  'Propagating',
  'Puttering',
  'Puzzling',
  'Quantumizing',
  'Razzle-dazzling',
  'Razzmatazzing',
  'Recombobulating',
  'Reticulating',
  'Roosting',
  'Ruminating',
  'Sautéing',
  'Scampering',
  'Schlepping',
  'Scurrying',
  'Seasoning',
  'Shenaniganing',
  'Shimmying',
  'Simmering',
  'Skedaddling',
  'Sketching',
  'Slithering',
  'Smooshing',
  'Sock-hopping',
  'Spelunking',
  'Spinning',
  'Sprouting',
  'Stewing',
  'Sublimating',
  'Swirling',
  'Swooping',
  'Symbioting',
  'Synthesizing',
  'Tempering',
  'Thinking',
  'Thundering',
  'Tinkering',
  'Tomfoolering',
  'Topsy-turvying',
  'Transfiguring',
  'Transmuting',
  'Twisting',
  'Undulating',
  'Unfurling',
  'Unravelling',
  'Vibing',
  'Waddling',
  'Wandering',
  'Warping',
  'Whatchamacalliting',
  'Whirlpooling',
  'Whirring',
  'Whisking',
  'Wibbling',
  'Working',
  'Wrangling',
  'Zesting',
  'Zigzagging',
  'Glooping',
  'Slorping',
  'Glarking',
  'Zorpning',
  'Blibbling',
  'Flooning',
  'Snarfing',
  'Gribbling',
  'Plonking',
  'Splinking',
  'Twizzling',
  'Shmoozing',
  'Blathering',
  'Jabbering',
  'Prattling',
  'Imploding',
  'Exploding',
  'Shattering',
  'Vortexing',
  'Sizzling',
  'Fizzing',
  'Popcorning',
  'Jiggling',
  'Wobbling',
  'Quaking',
  'Pulsing',
  'Throbbing',
  'Booming',
  'Clanging',
  'Rattling',
  'Flipping',
  'Flopping',
  'Plunging',
  'Diving',
  'Soaring',
  'Plummeting',
  'Spiraling',
  'Looping',
  'Tangling',
  'Knotting',
  'Unweaving',
  'Weaving',
  'Knitting',
  'Stitching',
  'Patching',
  'Gluing',
  'Melting',
  'Freezing',
  'Burning',
  'Charring',
  'Smoking',
  'Squelching',
  'Splutting',
  'Glugging',
  'Blooping',
  'Bzzting',
  'Krrrzting',
  'Whirclicking',
  'Beepbooping',
  'Hngghing',
  'Screeeing',
  'Mrowing',
  'Glarping',
  'Zonking',
  'Borking',
  'Glurping',
  'Splorching',
  'Zwinging',
  'Flubbing',
  'Hallucinating',
];

export default function (pi: ExtensionAPI) {
	pi.on("turn_start", async (_event, ctx) => {
		const verb = SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)];
		currentVerb = verb;
		currentColor = randomColor();
		startRainbowAnimation(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		stopRainbowAnimation();
		ctx.ui.setWorkingMessage();
		animationFrame = 0;
	});
}
