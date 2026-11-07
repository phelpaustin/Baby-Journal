export const ENTRY_TYPES = [
  { id: "memory", label: "Memory" },
  { id: "milestone", label: "Milestone" },
  { id: "growth", label: "Growth" },
  { id: "health", label: "Health" },
  { id: "vaccine", label: "Vaccine" },
  { id: "sleep", label: "Sleep" },
  { id: "feeding", label: "Feeding" },
  { id: "pregnancy", label: "Pregnancy" },
  { id: "appointment", label: "Appointment" },
  { id: "other", label: "Other" },
];
export const typeLabel = (id) => (ENTRY_TYPES.find((t) => t.id === id) || { label: id }).label;

// Common first-year milestones; people can also type their own.
export const MILESTONES = [
  ["first_smile", "First smile"], ["first_laugh", "First laugh"], ["held_head_up", "Held head up"],
  ["rolled_over", "Rolled over"], ["sat_up", "Sat up"], ["first_solid_food", "First solid food"],
  ["crawled", "Crawled"], ["first_tooth", "First tooth"], ["stood_up", "Stood up"],
  ["first_word", "First word"], ["first_steps", "First steps"], ["slept_through_night", "Slept through the night"],
];
export const milestoneLabel = (id) => (MILESTONES.find((m) => m[0] === id) || [id, id.replace(/_/g, " ")])[1];

// Measurements: the key carries the unit, which the server requires.
export const MEASUREMENTS = {
  growth: [["weight_kg", "Weight", "kg"], ["length_cm", "Length", "cm"], ["head_circumference_cm", "Head size", "cm"]],
  health: [["temperature_c", "Temperature", "°C"], ["weight_kg", "Weight", "kg"]],
  sleep: [["sleep_min", "Slept", "minutes"]],
  feeding: [["amount_ml", "Amount", "ml"]],
};
export const measurementLabel = (key) => {
  for (const list of Object.values(MEASUREMENTS)) {
    const m = list.find((x) => x[0] === key);
    if (m) return { label: m[1], unit: m[2] };
  }
  return { label: key.replace(/_/g, " "), unit: "" };
};
