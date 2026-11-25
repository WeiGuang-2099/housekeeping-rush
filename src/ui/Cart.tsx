/**
 * 布草车（docs/DESIGN.md 的"主界面的四个部件"）：格子数等于这一档的容量（params.cart.capacity），
 * 车里还有的份数（View 的 cart）是实心格，用掉的变空。文字一律从语言包取。
 * 预览时高亮这一步要用的份数（docs/DESIGN.md）：打扫第一次开门要用的那几格（最后几个实心格）；
 * 补货时高亮会补回来的空格。
 */

import { useText } from '../content';
import type { Preview } from './preview';
import type { ScreenProps } from './shift';

export interface CartProps extends ScreenProps {
  /** 正在预览的动作；没有、或者不合法时不高亮。 */
  readonly preview?: Preview | null;
}

export function Cart({ view, params, preview = null }: CartProps) {
  const t = useText();
  const capacity = params.cart.capacity;
  const left = view.cart;
  const plan = preview?.ok === true ? preview.plan : null;
  // 这一步要用掉的格子：下标 left - used 到 left 之前；补货补回的格子：下标 left 到 capacity 之前。
  const used = plan?.type === 'service' ? plan.linen : 0;
  const refill = plan?.type === 'restock' ? plan.refill : 0;
  const cellClass = (index: number): string => {
    if (index < left) return index >= left - used ? 'cart-cell is-full is-use' : 'cart-cell is-full';
    return index < left + refill ? 'cart-cell is-refill' : 'cart-cell';
  };
  const title = used > 0 ? t.cart.use(used) : refill > 0 ? t.cart.refill(refill) : undefined;
  return (
    <section className="cart" aria-label={t.cart.label(left, capacity)}>
      <span className="cart-title" aria-hidden="true">
        {t.cart.title}
      </span>
      <span className="cart-cells" aria-hidden="true" title={title}>
        {Array.from({ length: capacity }, (_, index) => (
          <span key={index} className={cellClass(index)} />
        ))}
      </span>
      <span className="cart-count mono" aria-hidden="true">
        {t.cart.count(left, capacity)}
      </span>
    </section>
  );
}
