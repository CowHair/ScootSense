// Rough, clearly-labelled estimates of a rider's environmental impact.
// Shown to users as "about" figures; the assumptions travel with the numbers.

/** Average petrol car, tailpipe CO2 per km (Canadian fleet is ~0.17-0.19 kg/km). */
export const CAR_KG_CO2_PER_KM = 0.17;

/** Typical item mass, and CO2e avoided when it is reused or recycled instead of landfilled. */
export const MATERIAL = {
  plastic: { kg: 0.025, co2: 0.08 },
  metal: { kg: 0.015, co2: 0.15 },
  glass: { kg: 0.2, co2: 0.1 },
  paper: { kg: 0.01, co2: 0.02 },
  cardboard: { kg: 0.05, co2: 0.05 },
  textile: { kg: 0.2, co2: 0.6 },
  organic: { kg: 0.05, co2: 0.03 },
  other: { kg: 0.03, co2: 0.05 },
};

/** A mature tree absorbs roughly 21 kg CO2 per year. */
const TREE_KG_PER_DAY = 21 / 365;

export function computeImpact(totals = {}, trash = []) {
  const km = totals.ride_km || 0;
  const rideKg = km * CAR_KG_CO2_PER_KM;
  let divertedKg = 0, litterKg = 0;
  for (const t of trash) {
    const m = MATERIAL[t.material] || MATERIAL.other;
    divertedKg += m.kg;
    litterKg += m.co2;
  }
  const total = rideKg + litterKg;
  const r = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
  return {
    km: r(km, 1),
    co2RideKg: r(rideKg),
    itemsPickedUp: trash.length || totals.pickup || 0,
    wasteDivertedKg: r(divertedKg),
    co2LitterKg: r(litterKg),
    co2TotalKg: r(total),
    treeDays: Math.round(total / TREE_KG_PER_DAY),
    assumptions: [
      `Each km on the scooter replaces a car trip at about ${CAR_KG_CO2_PER_KM} kg CO2 per km.`,
      'Picked-up litter is credited with typical item weights and the CO2e saved by reuse or recycling instead of landfill.',
      'A mature tree absorbs about 21 kg of CO2 a year.',
    ],
  };
}
