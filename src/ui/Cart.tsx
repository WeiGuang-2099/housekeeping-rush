/**
 * 布草车（docs/DESIGN.md 的"主界面的四个部件"）：格子数等于这一档的容量（params.cart.capacity），
 * 车里还有的份数（View 的 cart）是实心格，用掉的变空。文字一律从语言包取。
 * 预览时高亮下一间房要用的份数，是"动作预览和确认"那一项的事。
 */

import { useText } from '../content';
import type { ScreenProps } from './shift';

export function Cart({ view, params }: ScreenProps) {
  const t = useText();
  const capacity = params.cart.capacity;
  const left = view.cart;
  return (
    <section className="cart" aria-label={t.cart.label(left, capacity)}>
      <span className="cart-title" aria-hidden="true">
        {t.cart.title}
      </span>
      <span className="cart-cells" aria-hidden="true">
        {Array.from({ length: capacity }, (_, index) => (
          <span key={index} className={index < left ? 'cart-cell is-full' : 'cart-cell'} />
        ))}
      </span>
      <span className="cart-count mono" aria-hidden="true">
        {t.cart.count(left, capacity)}
      </span>
    </section>
  );
}
