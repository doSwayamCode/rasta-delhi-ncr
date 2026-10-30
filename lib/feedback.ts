/** Answer options for the in-app feedback questions. Shared by the form and the API. */
export const CHOICES = {
  priority: ["fastest", "people", "light", "main_roads", "familiar"],
  feel: ["safe", "mixed", "unsafe", "dont_know"],
} as const;

export const LABELS: Record<string, string> = {
  fastest: "Getting there fastest",
  people: "People and open shops around",
  light: "Well-lit streets",
  main_roads: "Sticking to main roads",
  familiar: "A route I already know",
  safe: "Yes, it feels safe",
  mixed: "Yes, some stretches don't",
  unsafe: "Yes, it feels unsafe",
  dont_know: "I don't really know it",
};
