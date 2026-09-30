import sys, numpy as np
from PIL import Image
PAPER=np.array([0xFA,0xF9,0xF6])
for f in sys.argv[1:]:
    a=np.asarray(Image.open(f).convert('RGB')).astype(np.int16)
    m=np.abs(a-PAPER).max(axis=2)>6
    ys=np.where(m.any(axis=1))[0]; xs=np.where(m.any(axis=0))[0]
    y0,y1,x0,x1=ys[0],ys[-1]+1,xs[0],xs[-1]+1
    Image.fromarray(a[y0:y1,x0:x1].astype(np.uint8)).save(f); print(f,(x1-x0,y1-y0),'%.2f:1'%((x1-x0)/(y1-y0)))
