export const samples = [
  { id: 'energy', kind: 'equation', label: 'Mass and energy', text: String.raw`$$E=mc^2$$` },
  {
    id: 'quadratic',
    kind: 'equation',
    label: 'Quadratic formula',
    text: String.raw`$$x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}$$`,
  },
  {
    id: 'integral',
    kind: 'equation',
    label: 'Gaussian integral',
    text: String.raw`$$\int_{-\infty}^{\infty}e^{-x^2}\,dx=\sqrt{\pi}$$`,
  },
  {
    id: 'sum',
    kind: 'equation',
    label: 'Finite sum',
    text: String.raw`$$\sum_{k=1}^{n}k=\frac{n(n+1)}{2}$$`,
  },
  {
    id: 'matrix',
    kind: 'equation',
    label: 'Matrix product',
    text: String.raw`$$\begin{pmatrix}a&b\\c&d\end{pmatrix}\begin{pmatrix}x\\y\end{pmatrix}=\begin{pmatrix}ax+by\\cx+dy\end{pmatrix}$$`,
  },
  {
    id: 'limit',
    kind: 'equation',
    label: 'Limit',
    text: String.raw`$$\lim_{x\to0}\frac{\sin x}{x}=1$$`,
  },
  {
    id: 'derivative',
    kind: 'equation',
    label: 'Partial derivative',
    text: String.raw`$$\frac{\partial^2 u}{\partial t^2}=c^2\frac{\partial^2u}{\partial x^2}$$`,
  },
  {
    id: 'piecewise',
    kind: 'equation',
    label: 'Piecewise function',
    text: String.raw`$$f(x)=\begin{cases}x^2,&x\ge0\\-x,&x<0\end{cases}$$`,
  },
  {
    id: 'aligned',
    kind: 'equation',
    label: 'Multiline equation',
    text: String.raw`$$\begin{aligned}(a+b)^2&=a^2+2ab+b^2\\(a-b)^2&=a^2-2ab+b^2\end{aligned}$$`,
  },
  {
    id: 'vector',
    kind: 'equation',
    label: 'Vector identity',
    text: String.raw`$$\nabla\cdot(\nabla\times\mathbf{F})=0$$`,
  },
  {
    id: 'mixed-energy',
    kind: 'mixed',
    label: 'Inline notation',
    text: String.raw`The energy is $E=mc^2$, where $m$ is the mass and $c$ is the speed of light.`,
  },
  {
    id: 'mixed-probability',
    kind: 'mixed',
    label: 'Conditional probability',
    text: String.raw`For events $A$ and $B$ with $P(B)>0$, the conditional probability is $P(A\mid B)=\frac{P(A\cap B)}{P(B)}$.`,
  },
  {
    id: 'mixed-integral',
    kind: 'mixed',
    label: 'Text and display math',
    text: String.raw`The integral of a power is given by
$$\int x^n\,dx=\frac{x^{n+1}}{n+1}+C.$$
This expression applies when $n\ne-1$.`,
  },
  {
    id: 'mixed-series',
    kind: 'mixed',
    label: 'Series and punctuation',
    text: String.raw`For $|r|<1$, the geometric series converges:
$$\sum_{k=0}^{\infty}r^k=\frac{1}{1-r}.$$
At $r=\frac12$, the sum is $2$.`,
  },
  {
    id: 'mixed-statistics',
    kind: 'mixed',
    label: 'Statistics',
    text: String.raw`Let $x_1,\ldots,x_n$ be observations. Their sample mean is $\bar{x}=\frac{1}{n}\sum_{i=1}^n x_i$. The number of observations is $n$.`,
  },
  {
    id: 'mixed-units',
    kind: 'mixed',
    label: 'Units and subscripts',
    text: String.raw`The initial speed is $v_0=12\,\mathrm{m/s}$. With acceleration $a=3\,\mathrm{m/s^2}$, the speed after time $t$ is $v(t)=v_0+at$.`,
  },
  {
    id: 'mixed-complex',
    kind: 'mixed',
    label: 'Complex numbers',
    text: String.raw`Euler's identity combines five constants:
$$e^{i\pi}+1=0.$$
Here $i^2=-1$ and $e$ is the base of the natural logarithm.`,
  },
  {
    id: 'mixed-gradient',
    kind: 'mixed',
    label: 'Gradient',
    text: String.raw`For $f(x,y)=x^2+y^2$, the gradient is $\nabla f=(2x,2y)$. At the origin, $\nabla f=(0,0)$.`,
  },
  {
    id: 'mixed-small',
    kind: 'mixed',
    label: 'Small text',
    text: String.raw`Assume $\epsilon>0$. Choose $\delta=\epsilon/3$. If $|x-a|<\delta$, then $3|x-a|<\epsilon$.`,
  },
  {
    id: 'mixed-multiline',
    kind: 'mixed',
    label: 'Several equations',
    text: String.raw`The position and velocity satisfy
$$s(t)=s_0+v_0t+\frac12at^2,$$
$$v(t)=v_0+at.$$
The acceleration $a$ is constant.`,
  },
] satisfies { id: string; kind: 'equation' | 'mixed'; label: string; text: string }[];
