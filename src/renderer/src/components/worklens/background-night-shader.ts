// Dark-surface designs for the background effects. Each shape keeps the name
// of its daylight design in background-shader.ts and is drawn as a deep tint
// with sparse, slow light instead of emitted pigment.
// Shapes: 0 fluid, 1 surface, 2 aurora, 3 silk, 4 caustics, 5 nebula.
export const nightShader = `precision mediump float;
uniform vec2 resolution;uniform float time,tone,shape,strength;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.),f.x),f.y);}
float fbm(vec2 p){float v=0.;float a=.55;for(int i=0;i<4;i++){v+=a*noise(p);p=mat2(.80,-.60,.60,.80)*p*2.02+3.17;a*=.48;}return v;}
// Long diagonal folds whose phase is bent by slower cross waves.
float silk(vec2 p,float t){
 float a=p.x*1.5+p.y*1.05;
 a+=.85*sin(p.y*1.8-t*.55+sin(p.x*1.25+t*.32));
 a+=.40*sin(p.x*2.6+p.y*.5+t*.41);
 return .5*sin(a*2.1)+.22*sin(a*4.3+t*.25);
}
// Iterated light focusing through a moving water surface.
float caustic(vec2 p,float t){
 vec2 i=p;float c=1.;
 for(int n=0;n<4;n++){
  float s=t*(1.-3.5/float(n+1));
  i=p+vec2(cos(s-i.x)+sin(s+i.y),sin(s-i.y)+cos(s+i.x));
  c+=1./length(vec2(p.x/(sin(i.x+s)*200.),p.y/(cos(i.y+s)*200.)));
 }
 c=1.17-pow(c*.25,1.4);
 return clamp(pow(abs(c),8.),0.,1.);
}
// Silk slope and height for shading.
vec3 bend(vec2 p,float t){
 float z=silk(p,t),e=.012;
 return vec3((silk(p+vec2(e,0.),t)-z)/e,(silk(p+vec2(0.,e),t)-z)/e,z);
}
float luminance(vec3 rgb){
 vec3 linear=mix(rgb/12.92,pow((rgb+.055)/1.055,vec3(2.4)),step(vec3(.04045),rgb));
 return dot(linear,vec3(.2126,.7152,.0722));
}
// Screen-blended over the dark scrim (90% #1c1c1e) on the brightest possible
// glass, the light must leave white titles at 4.7:1, selected rows included.
// Every surface draws the same light, so the sidebar and cards stay in step.
bool readable(vec3 emitted){
 vec3 base=vec3(.199,.199,.206);
 vec3 behind=base+emitted*(1.-base);
 return luminance(behind)<=.153&&luminance(behind+.12*(1.-behind))<=.158;
}
void main(){
 vec2 uv=gl_FragCoord.xy/resolution;
 // Aspect-correct coordinates keep patterns undistorted in tall panels.
 vec2 a=gl_FragCoord.xy/max(resolution.y,1.);
 float y=1.-uv.y;float x=uv.x;float t=time;
 // Deep base, broad glow and the sparse accent for each palette.
 vec3 deep=vec3(.09,.07,.20),glow=vec3(.42,.36,.86),spark=vec3(.70,.66,1.);
 if(tone>4.5){deep=vec3(.08,.04,.19);glow=vec3(.46,.24,.95);spark=vec3(.30,.90,1.);}
 else if(tone>3.5){deep=vec3(.13,.05,.13);glow=vec3(.74,.38,.66);spark=vec3(1.,.74,.86);}
 else if(tone>2.5){deep=vec3(.03,.07,.17);glow=vec3(.18,.44,.86);spark=vec3(.52,.80,1.);}
 else if(tone>1.5){deep=vec3(.04,.09,.08);glow=vec3(.24,.50,.40);spark=vec3(.64,.90,.72);}
 float low=smoothstep(.10,1.,y);
 vec3 c;
 if(shape<.5){
  // Slow smoke, with brighter wisps only in the lower half.
  vec2 p=vec2(x*.7,uv.y*1.8);
  vec2 q=vec2(fbm(p+vec2(0.,t*.03)),fbm(p+vec2(4.3,-t*.025)));
  float f=fbm(p+2.4*q+vec2(t*.015,0.));
  float wisp=smoothstep(.48,.84,f);
  c=deep*(.55+.9*low)+glow*wisp*.48*(.25+.75*low)+spark*pow(wisp,4.)*.22*low;
 }else if(shape<1.5){
  // A tinted panel with one pool of light breathing in the corner.
  vec2 d=vec2((x-.05)*.95,y-1.06);
  float pool=exp(-dot(d,d)*(2.3+.25*sin(t*.22)));
  c=deep*(.45+.75*low)+glow*pool*.34+spark*pow(pool,4.)*.10;
 }else if(shape<2.5){
  // Curtains of light rising from the bottom edge.
  float sway=.05*sin(uv.y*3.+t*.12)+.035*sin(x*7.+t*.09);
  float rays=mix(.30,1.,fbm(vec2(x*9.,t*.04)));
  float band=smoothstep(.56,1.,y+sway);
  vec3 hue=mix(glow,spark,smoothstep(.80,1.05,y+sway));
  c=deep*(.35+.6*low)+hue*band*rays*.34;
 }else if(shape<3.5){
  // Dark fabric draped in fine diagonal folds with a soft sheen.
  vec3 g=bend(a*3.4+vec2(.2,0.),t*.06);
  vec3 normal=normalize(vec3(-g.xy*.14,1.));
  vec3 light=normalize(vec3(-.45,.70,.90));
  float satin=pow(max(dot(normal,light),0.),3.);
  float fade=smoothstep(.0,.95,y+(.5-x)*.25);
  c=deep*(.5+.6*low)+(glow*(.08+.20*satin)+spark*satin*satin*.04)*fade;
 }else if(shape<4.5){
  // A dim water net confined to the lower half.
  float k=caustic(a*6.5-vec2(250.),t*.10+19.);
  float m=smoothstep(.28,1.,y);
  c=deep*(.5+.6*low)+mix(glow,spark,k)*k*.62*m;
 }else{
  // Deep cloud and a few twinkling stars.
  vec2 np=a*2.3;
  float n1=fbm(np*1.2+vec2(t*.04,-t*.03));
  float n2=fbm(np*2.+n1*1.7-vec2(t*.02,t*.03));
  float cloud=smoothstep(.35,.85,n2);
  c=deep*(.55+.5*low)+glow*cloud*.24*(.4+.6*low);
  vec2 cell=floor(gl_FragCoord.xy/12.),local=fract(gl_FragCoord.xy/12.);
  float h=hash(cell);
  vec2 at=.2+.6*vec2(hash(cell+7.1),hash(cell+3.3));
  float twinkle=.35+.65*(.5+.5*sin(t*(.6+h*1.4)+h*40.));
  float star=step(.88,h)*twinkle*exp(-dot(local-at,local-at)*220.);
  c+=mix(spark,vec3(1.),.5)*star*.55;
 }
 // Static grain keeps the deep gradients from banding.
 c+=(hash(gl_FragCoord.xy)-.5)*.016;
 // 50 maps to strength 1; full intensity doubles the light within the limit.
 c=clamp(c*strength,0.,1.);
 if(!readable(c)){
  float lo=0.,hi=1.;
  for(int i=0;i<7;i++){float m=.5*(lo+hi);if(readable(c*m))lo=m;else hi=m;}
  c*=lo;
 }
 // Premultiplied: the alpha only needs to cover the emitted light.
 gl_FragColor=vec4(c,max(c.r,max(c.g,c.b)));
}`;
