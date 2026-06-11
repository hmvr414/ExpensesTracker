export function paymentMethodIcon(kind: string): string {
  switch (kind) {
    case 'cash':
      return '💵';
    case 'card':
      return '💳';
    case 'bank_transfer':
      return '🏦';
    default:
      return '💼';
  }
}
