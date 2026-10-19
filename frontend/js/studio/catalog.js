// Each choice contributes a concrete instruction; only one choice per detail unless marked multiple.
const choice = (id, label, prompt, icon, hint = '') => ({ id, label, prompt, icon, hint });
const section = (id, label, options, multiple = false) => ({ id, label, options, multiple });

export const CATEGORIES = [
  { id: 'camera', label: 'Camera', icon: 'camera', sections: [
    section('framing', 'Framing', [
      choice('full', 'Full body', 'full-body composition, head and feet entirely in frame', 'body-scan', 'Head to toe'),
      choice('three-quarter', 'Three-quarter crop', 'three-quarter length composition, framed from head to knees', 'user-scan', 'Head to knees'),
      choice('waist', 'Waist-up', 'waist-up portrait composition', 'user', 'Head to waist'),
      choice('headshot', 'Headshot', 'head-and-shoulders portrait', 'user-circle', 'Head and shoulders'),
      choice('close', 'Close-up', 'close-up portrait filling the frame with the face', 'focus-2', 'Face fills the frame'),
      choice('wide', 'Environmental', 'wide environmental portrait with the subject small in the scene', 'frame', 'Include the surroundings'),
    ]),
    section('angle', 'Camera angle', [
      choice('eye', 'Eye level', 'camera at the subject’s eye level', 'eye', 'Natural perspective'),
      choice('low', 'Low angle', 'camera below eye level, angled upward toward the subject', 'arrow-up-right', 'Look up at the subject'),
      choice('high', 'High angle', 'camera above eye level, angled downward toward the subject', 'arrow-down-right', 'Look down at the subject'),
      choice('profile', 'Side profile', 'camera viewing the subject in side profile', 'user', '90° from the front'),
      choice('quarter', 'Three-quarter', 'camera viewing the subject from a three-quarter angle', 'rotate', '45° from the front'),
      choice('shoulder', 'Over shoulder', 'over-the-shoulder camera view', 'users', 'Behind one shoulder'),
      choice('back', 'Rear view', 'camera behind the subject, showing their back', 'arrow-back-up', 'From behind'),
      choice('top', 'Overhead', 'camera directly overhead, looking straight down', 'arrow-down', 'Bird’s-eye view'),
      choice('dutch', 'Dutch angle', 'subtly tilted camera horizon, Dutch angle composition', 'rotate-clockwise', 'Tilted horizon'),
    ]),
    section('lens', 'Lens', [
      choice('24', '24 mm', '24mm wide-angle lens with environmental perspective', 'panorama-horizontal', 'Wide environment'),
      choice('35', '35 mm', '35mm lens, natural documentary perspective', 'camera', 'Lifestyle / documentary'),
      choice('50', '50 mm', '50mm lens with a natural perspective', 'aperture', 'Natural perspective'),
      choice('85', '85 mm', '85mm portrait lens, compressed background', 'focus', 'Classic portrait'),
      choice('135', '135 mm', '135mm telephoto portrait lens, strong background compression', 'focus-2', 'Compressed background'),
    ]),
    section('focus', 'Depth of field', [
      choice('shallow', 'Soft background', 'shallow depth of field, subject in sharp focus, soft background bokeh', 'blur', 'Separate the subject'),
      choice('deep', 'Everything sharp', 'deep depth of field with subject and background in focus', 'focus', 'Detailed surroundings'),
      choice('motion', 'Motion blur', 'sharp subject with subtle motion blur in the background', 'wind', 'Movement in the scene'),
    ]),
  ] },
  { id: 'scene', label: 'Scene', icon: 'mountain', sections: [
    section('location', 'Location', [
      choice('studio', 'Photo studio', 'in a seamless light-gray photography studio', 'photo', 'Clean seamless backdrop'),
      choice('street', 'City street', 'on a stylish city street with architectural details', 'building', 'Urban street setting'),
      choice('cafe', 'Sidewalk café', 'at an outdoor sidewalk café', 'coffee', 'Tables and street life'),
      choice('rooftop', 'Rooftop', 'on a rooftop terrace overlooking the city', 'buildings', 'Open city skyline'),
      choice('apartment', 'Apartment', 'in a bright contemporary apartment', 'sofa', 'Relaxed interior'),
      choice('bedroom', 'Bedroom', 'in a softly lit, neatly styled bedroom', 'bed', 'Soft domestic setting'),
      choice('beach', 'Beach', 'on a sandy beach with the ocean in the background', 'beach', 'Sand and ocean'),
      choice('garden', 'Garden', 'in a lush botanical garden', 'plant', 'Greenery and flowers'),
      choice('forest', 'Forest', 'on a woodland path surrounded by trees', 'trees', 'Natural woodland'),
      choice('gym', 'Gym', 'in a modern gym with exercise equipment', 'barbell', 'Fitness setting'),
      choice('gallery', 'Art gallery', 'in a minimalist contemporary art gallery', 'frame', 'Calm curated interior'),
      choice('hotel', 'Hotel lobby', 'in an elegant boutique hotel lobby', 'building', 'Refined hospitality'),
      choice('car', 'Car interior', 'inside a parked car with visible window light', 'car', 'Parked vehicle'),
      choice('kitchen', 'Kitchen', 'in a bright modern kitchen', 'tools-kitchen-2', 'Everyday lifestyle'),
      choice('restaurant', 'Restaurant', 'in an elegant restaurant dining room', 'glass', 'Evening dining'),
      choice('snow', 'Snowy mountains', 'against a snowy mountain landscape', 'mountain', 'Alpine setting'),
    ]),
    section('time', 'Time of day', [
      choice('morning', 'Early morning', 'early morning atmosphere', 'sunrise'),
      choice('midday', 'Midday', 'midday atmosphere', 'sun'),
      choice('sunset', 'Golden hour', 'late-afternoon golden-hour atmosphere', 'sunset'),
      choice('blue', 'Blue hour', 'blue-hour twilight atmosphere', 'moon-stars'),
      choice('night', 'Night', 'nighttime atmosphere', 'moon'),
    ]),
    section('weather', 'Weather', [
      choice('clear', 'Clear sky', 'clear weather', 'sun'),
      choice('cloudy', 'Overcast', 'soft overcast weather', 'cloud'),
      choice('rain', 'Rain', 'light rain with wet reflective surfaces', 'cloud-rain'),
      choice('mist', 'Misty', 'subtle atmospheric mist', 'mist'),
    ]),
  ] },
  { id: 'action', label: 'Action', icon: 'walk', sections: [
    section('activity', 'What are they doing?', [
      choice('still', 'Posing', 'posing calmly for the camera', 'user'),
      choice('stroll', 'Strolling', 'taking a relaxed stroll', 'walk'),
      choice('dance', 'Dancing', 'performing a fluid dance movement', 'yoga'),
      choice('run', 'Running', 'running naturally', 'run'),
      choice('coffee', 'Drinking coffee', 'holding a cup and taking a sip of coffee', 'coffee'),
      choice('read', 'Reading', 'reading an open book', 'book'),
      choice('phone', 'Using a phone', 'looking at a smartphone held in one hand', 'device-mobile'),
      choice('selfie', 'Taking a selfie', 'holding a smartphone out to take a selfie', 'camera-selfie'),
      choice('talk', 'Talking', 'mid-conversation with an animated natural gesture', 'message-circle'),
      choice('laugh', 'Laughing', 'laughing spontaneously', 'mood-happy'),
      choice('hair', 'Adjusting hair', 'gently brushing hair away from the face', 'cut'),
      choice('jacket', 'Adjusting jacket', 'adjusting the lapels of a jacket', 'jacket'),
      choice('cook', 'Cooking', 'preparing food at a kitchen counter', 'tools-kitchen-2'),
      choice('work', 'Working', 'working on an open laptop', 'device-laptop'),
      choice('stretch', 'Stretching', 'doing a gentle standing stretch', 'stretching'),
      choice('turn', 'Turning around', 'turning naturally toward the camera', 'rotate'),
    ]),
  ] },
  { id: 'pose', label: 'Pose', icon: 'man', sections: [
    section('body', 'Body position', [
      choice('stand', 'Standing', 'standing upright in a relaxed natural posture', 'man', 'Weight evenly balanced'),
      choice('sit', 'Seated', 'seated comfortably on a chair', 'armchair', 'Relaxed upright sitting'),
      choice('walk', 'Walking', 'caught naturally mid-stride', 'walk', 'One foot stepping forward'),
      choice('lean', 'Leaning', 'leaning lightly against a nearby wall or surface', 'stretching', 'Support on one side'),
      choice('hip', 'Weight on one leg', 'standing with weight on one leg and a relaxed hip shift', 'woman', 'Natural asymmetry'),
      choice('cross', 'Legs crossed', 'standing with ankles casually crossed', 'man', 'Relaxed standing pose'),
      choice('floor', 'On the floor', 'seated on the floor with legs comfortably folded', 'yoga', 'Grounded seated pose'),
      choice('squat', 'Crouching', 'crouching with knees bent in a balanced pose', 'stretching', 'Lowered stance'),
    ]),
    section('hands', 'Arms & hands', [
      choice('pockets', 'Hands in pockets', 'both hands casually in trouser pockets', 'man', 'Elbows slightly bent'),
      choice('hips', 'Hands on hips', 'hands resting on hips, elbows angled outward', 'stretching', 'Open shoulders'),
      choice('folded', 'Arms folded', 'arms loosely folded across the chest', 'user', 'Relaxed crossed arms'),
      choice('loose', 'Arms at sides', 'arms relaxed naturally at the sides', 'man', 'Open relaxed posture'),
      choice('chin', 'Hand to chin', 'one hand resting lightly near the chin', 'user-circle', 'Thoughtful gesture'),
      choice('hair', 'Hand in hair', 'one hand gently touching the hair', 'cut', 'Casual styling gesture'),
      choice('overhead', 'Arms overhead', 'arms raised overhead in a relaxed stretch', 'stretching', 'Long body line'),
      choice('clasped', 'Hands clasped', 'hands loosely clasped in front of the body', 'hand-stop', 'Gentle closed gesture'),
    ]),
    section('gaze', 'Head & gaze', [
      choice('camera', 'At the camera', 'looking directly into the camera', 'eye'),
      choice('away', 'Looking away', 'gazing just past the camera', 'arrow-right'),
      choice('back', 'Looking back', 'looking back over one shoulder', 'arrow-back-up'),
      choice('down', 'Looking down', 'eyes gently looking downward', 'arrow-down'),
      choice('up', 'Looking up', 'chin slightly lifted, eyes looking upward', 'arrow-up'),
      choice('closed', 'Eyes closed', 'eyes gently closed', 'eye-closed'),
    ]),
  ] },
  { id: 'outfit', label: 'Outfit', icon: 'hanger', sections: [
    section('look', 'Complete look', [
      choice('tailored', 'Tailored', 'wearing a fitted black turtleneck, gray wide-leg tailored trousers and black loafers', 'jacket', 'Structured separates'),
      choice('street', 'Streetwear', 'wearing an oversized graphic T-shirt, cargo trousers and sneakers', 'shirt', 'Relaxed urban layers'),
      choice('casual', 'Everyday', 'wearing a plain cotton T-shirt, straight-leg jeans and simple sneakers', 'shirt', 'Everyday essentials'),
      choice('evening', 'Evening', 'wearing an elegant evening dress and refined heels', 'woman', 'Formal occasion'),
      choice('active', 'Athleisure', 'wearing coordinated athletic leggings, a sports top and trainers', 'barbell', 'Sport-inspired styling'),
      choice('summer', 'Summer linen', 'wearing a relaxed linen shirt, linen trousers and sandals', 'sun', 'Light breathable fabrics'),
      choice('winter', 'Winter layers', 'wearing a wool coat over a knit sweater, dark trousers and boots', 'jacket', 'Warm layered styling'),
      choice('denim', 'Denim', 'wearing a denim jacket, plain top and straight-leg jeans', 'jacket', 'Classic denim layers'),
    ]),
    section('top', 'Top / override', [
      choice('tee', 'Plain T-shirt', 'upper garment: a plain crew-neck T-shirt', 'shirt'),
      choice('shirt', 'Button-up shirt', 'upper garment: a crisp button-up shirt', 'shirt'),
      choice('knit', 'Knit sweater', 'upper garment: a textured knit sweater', 'shirt'),
      choice('blazer', 'Blazer', 'upper layer: a structured tailored blazer', 'jacket'),
      choice('hoodie', 'Hoodie', 'upper garment: a relaxed hooded sweatshirt', 'jacket'),
      choice('tank', 'Tank top', 'upper garment: a simple sleeveless tank top', 'shirt'),
    ]),
    section('bottom', 'Bottom / override', [
      choice('trousers', 'Tailored trousers', 'lower garment: wide-leg tailored trousers', 'hanger'),
      choice('jeans', 'Straight jeans', 'lower garment: straight-leg denim jeans', 'hanger'),
      choice('skirt', 'Midi skirt', 'lower garment: a flowing midi skirt', 'woman'),
      choice('shorts', 'Shorts', 'lower garment: tailored knee-length shorts', 'hanger'),
      choice('leggings', 'Leggings', 'lower garment: fitted athletic leggings', 'barbell'),
    ]),
    section('shoes', 'Footwear / override', [
      choice('loafers', 'Loafers', 'footwear: black leather loafers', 'shoe'),
      choice('sneakers', 'Sneakers', 'footwear: clean white sneakers', 'shoe'),
      choice('boots', 'Boots', 'footwear: leather ankle boots', 'shoe'),
      choice('heels', 'Heels', 'footwear: classic pointed-toe heels', 'shoe'),
      choice('sandals', 'Sandals', 'footwear: minimal leather sandals', 'shoe'),
    ]),
    section('colour', 'Palette', [
      choice('mono', 'Monochrome', 'outfit colour palette: black, white and gray', 'palette'),
      choice('neutral', 'Warm neutrals', 'outfit colour palette: beige, cream and warm brown', 'palette'),
      choice('blue', 'Cool blues', 'outfit colour palette: navy and soft blue', 'palette'),
      choice('earth', 'Earth tones', 'outfit colour palette: olive, rust and earthy brown', 'palette'),
      choice('pastel', 'Pastels', 'outfit colour palette: delicate pastel tones', 'palette'),
      choice('bold', 'Bold colour', 'outfit colour palette: vibrant saturated accent colours', 'palette'),
    ]),
  ] },
  { id: 'expression', label: 'Expression', icon: 'mood-smile', sections: [
    section('mood', 'Expression', [
      choice('neutral', 'Neutral', 'relaxed neutral facial expression', 'mood-neutral'),
      choice('soft', 'Soft smile', 'a gentle closed-mouth smile', 'mood-smile'),
      choice('happy', 'Big smile', 'a warm open smile', 'mood-happy'),
      choice('serious', 'Serious', 'composed serious facial expression', 'mood-neutral'),
      choice('thoughtful', 'Thoughtful', 'a thoughtful contemplative expression', 'user-circle'),
      choice('confident', 'Confident', 'a calm self-assured expression', 'mood-smile'),
      choice('surprised', 'Surprised', 'a naturally surprised facial expression', 'mood-surprised'),
      choice('playful', 'Playful', 'a playful candid facial expression', 'mood-wink'),
    ]),
  ] },
  { id: 'lighting', label: 'Lighting', icon: 'sun', sections: [
    section('light', 'Light setup', [
      choice('soft', 'Soft daylight', 'soft diffused daylight with gentle shadows', 'sun', 'Even natural light'),
      choice('window', 'Window light', 'directional natural light from a large window', 'window', 'Soft side illumination'),
      choice('studio', 'Studio softbox', 'large diffused studio softbox lighting', 'bulb', 'Controlled studio light'),
      choice('golden', 'Golden glow', 'warm golden-hour sunlight with soft rim light', 'sunset', 'Warm low sunlight'),
      choice('hard', 'Hard sunlight', 'direct hard sunlight with crisp defined shadows', 'sun-high', 'Strong contrast'),
      choice('flash', 'Direct flash', 'direct on-camera flash photography', 'bolt', 'Crisp editorial flash'),
      choice('rim', 'Rim light', 'dramatic rim light outlining the subject', 'circle-half-2', 'Edge separation'),
      choice('neon', 'Neon', 'coloured neon lighting from nearby signs', 'bulb', 'Coloured night light'),
      choice('low', 'Low key', 'low-key lighting with deep shadows and restrained highlights', 'moon', 'Dramatic shadows'),
      choice('high', 'High key', 'high-key bright lighting with very soft shadows', 'brightness-up', 'Bright and airy'),
    ]),
    section('tone', 'Colour temperature', [
      choice('neutral', 'Neutral', 'neutral balanced white balance', 'temperature'),
      choice('warm', 'Warm', 'warm colour temperature', 'sun'),
      choice('cool', 'Cool', 'cool colour temperature', 'snowflake'),
    ]),
  ] },
  { id: 'details', label: 'Details', icon: 'adjustments', sections: [
    section('hair', 'Hair styling', [
      choice('natural', 'Natural', 'hair styled naturally', 'user-circle'),
      choice('waves', 'Loose waves', 'hair styled in loose soft waves', 'wind'),
      choice('straight', 'Sleek straight', 'hair styled sleek and straight', 'cut'),
      choice('pony', 'Ponytail', 'hair tied in a neat ponytail', 'user-circle'),
      choice('bun', 'Bun', 'hair gathered in a neat bun', 'user-circle'),
      choice('tousled', 'Tousled', 'hair loosely tousled with natural movement', 'wind'),
    ]),
    section('makeup', 'Makeup', [
      choice('minimal', 'Minimal', 'minimal natural-looking makeup', 'mood-smile'),
      choice('soft', 'Soft glam', 'subtle soft-glam makeup', 'sparkles'),
      choice('bold', 'Bold lip', 'a defined bold lip colour with restrained eye makeup', 'palette'),
      choice('none', 'Bare face', 'a bare face without visible makeup', 'user-circle'),
    ]),
    section('accessories', 'Accessories', [
      choice('earrings', 'Small earrings', 'small understated earrings', 'circle'),
      choice('necklace', 'Necklace', 'a delicate necklace', 'diamond'),
      choice('watch', 'Watch', 'a simple wristwatch', 'clock'),
      choice('glasses', 'Glasses', 'clear-lens prescription glasses', 'eyeglass'),
      choice('sunglasses', 'Sunglasses', 'stylish sunglasses', 'sunglasses'),
      choice('bag', 'Shoulder bag', 'a small leather shoulder bag', 'shopping-bag'),
      choice('hat', 'Hat', 'a simple brimmed hat', 'user-circle'),
      choice('scarf', 'Scarf', 'a softly draped scarf', 'hanger'),
    ], true),
    section('finish', 'Photographic finish', [
      choice('natural', 'Natural texture', 'natural skin texture and realistic fabric detail', 'focus'),
      choice('editorial', 'Editorial', 'refined fashion-editorial photography', 'photo'),
      choice('film', '35mm film', 'subtle 35mm film grain and gentle filmic colours', 'camera'),
      choice('bw', 'Black & white', 'black-and-white photography with rich tonal detail', 'circle-half-2'),
      choice('candid', 'Candid', 'authentic candid lifestyle photography', 'camera-selfie'),
    ]),
  ] },
];

export const SECTIONS = CATEGORIES.flatMap(category => category.sections.map(item => ({ ...item, category: category.id })));
export const DEFAULT_SELECTIONS = { framing: 'full', angle: 'quarter', body: 'stand', hands: 'pockets', look: 'tailored', light: 'soft', finish: 'natural' };

export function normalizeRecipe(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
  const selections = {};
  for (const item of SECTIONS) {
    const valid = new Set(item.options.map(option => option.id));
    const selected = value.selections?.[item.id];
    if (item.multiple) selections[item.id] = Array.isArray(selected) ? [...new Set(selected.filter(id => valid.has(id)))] : [];
    else if (valid.has(selected)) selections[item.id] = selected;
  }
  return {
    selections,
    character: typeof value.character === 'string' ? value.character.slice(0, 80) : '',
    identity: typeof value.identity === 'string' ? value.identity.slice(0, 250) : '',
    extra: typeof value.extra === 'string' ? value.extra.slice(0, 3000) : '',
    mode: value.mode === 'manual' ? 'manual' : 'builder',
  };
}

export function selectedDirections(value) {
  const recipe = normalizeRecipe(value);
  return SECTIONS.flatMap(item => {
    const selected = recipe.selections[item.id];
    return item.options.filter(option => item.multiple ? selected.includes(option.id) : option.id === selected)
      .flatMap(option => {
        let prompt = option.prompt;
        if (item.id === 'look' && ['top', 'bottom', 'shoes'].some(id => recipe.selections[id])) {
          const remaining = LOOK_GARMENTS[option.id].filter((_, i) => !recipe.selections[['top', 'bottom', 'shoes'][i]]);
          if (!remaining.length) return [];
          prompt = 'wearing ' + remaining.join(', ');
        }
        return [{ ...option, prompt, section: item.id, category: item.category }];
      });
  });
}

const LOOK_GARMENTS = {
  tailored: ['a fitted black turtleneck', 'gray wide-leg tailored trousers', 'black loafers'],
  street: ['an oversized graphic T-shirt', 'cargo trousers', 'sneakers'],
  casual: ['a plain cotton T-shirt', 'straight-leg jeans', 'simple sneakers'],
  evening: ['an elegant evening top', 'a coordinating formal skirt', 'refined heels'],
  active: ['a sports top', 'coordinated athletic leggings', 'trainers'],
  summer: ['a relaxed linen shirt', 'linen trousers', 'sandals'],
  winter: ['a wool coat over a knit sweater', 'dark trousers', 'boots'],
  denim: ['a denim jacket over a plain top', 'straight-leg jeans', 'sneakers'],
};

export function composePrompt(value) {
  const recipe = normalizeRecipe(value);
  const subject = recipe.identity.trim() || 'An adult character';
  const directions = selectedDirections(recipe);
  const sections = CATEGORIES.map(category => directions.filter(item => item.category === category.id)
    .map(item => item.prompt).join('; ')).filter(Boolean);
  return [subject, ...sections, recipe.extra.trim()].filter(Boolean).map(text => text.replace(/[.;\s]+$/u, '') + '.').join(' ');
}

export function chooseDirection(value, sectionId, optionId) {
  const recipe = normalizeRecipe(value);
  const section = SECTIONS.find(item => item.id === sectionId);
  if (!section?.options.some(item => item.id === optionId)) return recipe;
  recipe.mode = 'builder';
  if (section.multiple) {
    const selected = recipe.selections[sectionId];
    recipe.selections[sectionId] = selected.includes(optionId) ? selected.filter(id => id !== optionId) : [...selected, optionId];
  } else if (recipe.selections[sectionId] === optionId) delete recipe.selections[sectionId];
  else {
    recipe.selections[sectionId] = optionId;
    const moving = ['stroll', 'dance', 'run', 'stretch', 'turn'];
    const busyHands = ['coffee', 'read', 'phone', 'selfie', 'hair', 'jacket', 'cook', 'work'];
    if (sectionId === 'activity' && moving.includes(optionId)) delete recipe.selections.body;
    if (sectionId === 'activity' && busyHands.includes(optionId)) delete recipe.selections.hands;
    if (sectionId === 'body' && moving.includes(recipe.selections.activity)) delete recipe.selections.activity;
    if (sectionId === 'hands' && busyHands.includes(recipe.selections.activity)) delete recipe.selections.activity;
    if (sectionId === 'look') for (const id of ['top', 'bottom', 'shoes']) delete recipe.selections[id];
  }
  return recipe;
}
