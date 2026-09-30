import sys, numpy as np
from PIL import Image
from scipy import ndimage
PAPER=np.array([0xFA,0xF9,0xF6],dtype=np.float32)
for f in sys.argv[1:]:
    a=np.asarray(Image.open(f).convert('RGB')).astype(np.float32)
    corner=np.median(np.concatenate([a[:20,:20].reshape(-1,3),a[:20,-20:].reshape(-1,3),a[-20:,:20].reshape(-1,3),a[-20:,-20:].reshape(-1,3)]),axis=0)
    rough=(np.abs(a-corner).max(axis=2)<=16).astype(np.float32)
    num=np.stack([ndimage.gaussian_filter(a[...,c]*rough,40) for c in range(3)],axis=2)
    den=ndimage.gaussian_filter(rough,40)[...,None]+1e-3
    field=num/den
    mask=np.abs(a-field).max(axis=2)<=9
    lab,n=ndimage.label(mask)
    edge=set(lab[0,:])|set(lab[-1,:])|set(lab[:,0])|set(lab[:,-1]); edge.discard(0)
    bg=np.isin(lab,list(edge))
    a[bg]=PAPER
    Image.fromarray(np.clip(a,0,255).astype(np.uint8)).save(f)
    print(f,'bg %.1f%%'%(bg.mean()*100))
