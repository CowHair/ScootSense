// Only call after the database transaction succeeds.
export async function celebrateCollection(button) {
  button.dataset.collected = 'true';
  button.textContent = 'Collected! +1';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  await new Promise(resolve => setTimeout(resolve, reduced ? 650 : 1500));
}
