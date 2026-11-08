const integer = String.raw`(?:\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)`;
const unit = String.raw`(?:шт(?:ук[аи]?)?|ед(?:иниц[аы]?)?)\.?`;
const reviewCount = new RegExp(String.raw`^(${integer})\s+отзыв(?:а|ов)?$`, 'iu');
const quantityField = new RegExp(String.raw`^(${integer})(?:\s*${unit})?$`, 'iu');
const stockStatement = new RegExp(
  String.raw`^(?:в\s+наличии(?:\s*:\s*|\s+[–—-]\s+|\s+)(${integer})(?:\s*${unit})?|(${integer})\s*${unit}\s+в\s+наличии)[.!]?$`,
  'iu',
);

function parseCount(value: string | undefined): number | null {
  if (value === undefined) return null;
  const count = Number(value.replace(/\s/g, ''));
  return Number.isSafeInteger(count) ? count : null;
}

export function parseSellerReviewCount(captions: string[]): number | null {
  const counts = new Set<number>();
  for (const caption of captions) {
    const text = caption.trim();
    const count = /^(?:(?:пока )?нет отзывов|отзывов нет)$/iu.test(text)
      ? 0
      : parseCount(text.match(reviewCount)?.[1]);
    if (count !== null) counts.add(count);
  }
  return counts.size === 1 ? [...counts][0] : null;
}

export function parseAvailableQuantity(
  specifications: Record<string, string> | undefined,
  description: string,
): number | null {
  const fieldCounts = Object.entries(specifications ?? {})
    .filter(([label]) => /^(?:количество|остаток)\s+в\s+наличии$/iu.test(label))
    .map(([, value]) => parseCount(value.trim().match(quantityField)?.[1]));
  const descriptionCounts = description
    .split(/\r?\n|(?<![шШ][тТ]\.)(?<![еЕ][дД]\.)(?<=[.!?])\s+(?=[A-ZА-ЯЁ])/u)
    .map((statement) => statement.trim().replace(/^[•●▪]\s*/u, ''))
    .filter((statement) => /(?:^|[^а-яё])в\s+наличии(?![а-яё])/iu.test(statement))
    .map((statement) => {
      const match = statement.match(stockStatement);
      return parseCount(match?.[1] ?? match?.[2]);
    });

  // A dedicated field takes precedence over vague text, but exact counts must agree.
  const counts = new Set(
    fieldCounts.length > 0
      ? [...fieldCounts, ...descriptionCounts.filter((count) => count !== null)]
      : descriptionCounts,
  );
  return counts.size === 1 && !counts.has(null) ? [...counts][0] : null;
}
