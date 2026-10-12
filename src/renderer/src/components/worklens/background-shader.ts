// Procedural surface shading and domain warping; no textures or physics solver.
// Shapes: 0 fluid, 1 surface, 2 aurora, 3 silk, 4 caustics, 5 nebula.
export const backgroundShader = `precision mediump float;
uniform vec2 resolution;uniform float time,tone,shape,dark,strength;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.),f.x),f.y);}
float fbm(vec2 p){float v=0.;float a=.55;for(int i=0;i<4;i++){v+=a*noise(p);p=mat2(.80,-.60,.60,.80)*p*2.02+3.17;a*=.48;}return v;}
float surface(vec2 p,float t){
 return .46*sin(p.x*2.2+p.y*1.7+t*.31)
       +.32*cos(p.y*2.8-p.x*.7-t*.23)
       +.13*sin(p.x*3.4-p.y*1.3+t*.15);
}
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
void main(){
vec2 uv=gl_FragCoord.xy/resolution;float y=1.-uv.y;float sx=uv.x;
float mask=smoothstep(.22,.66,y);
if(shape>2.5&&shape<3.5)mask=smoothstep(.10,.72,y+(.5-sx)*.28);
else if(shape>3.5&&shape<4.5)mask=smoothstep(.12,.70,y);
else if(shape>4.5)mask=.30+.70*smoothstep(.05,.80,y);
if(mask<.001){gl_FragColor=vec4(0.);return;}
vec2 p=vec2(sx*.6,uv.y*1.9);float t=time*.065;
vec3 color;
vec3 deep=vec3(.035,.035,.12),middle=vec3(.18,.24,.48),pale=vec3(.55,.43,.61);
// Tones: 1 blue violet, 2 jade, 3 ocean, 4 dusk, 5 neon.
if(tone>4.5){deep=vec3(.06,.02,.16);middle=vec3(.34,.16,.72);pale=vec3(.32,.86,.96);}
else if(tone>3.5){deep=vec3(.13,.025,.08);middle=vec3(.48,.15,.24);pale=vec3(.83,.46,.29);}
else if(tone>2.5){deep=vec3(.01,.05,.14);middle=vec3(.04,.30,.62);pale=vec3(.38,.78,.96);}
else if(tone>1.5){deep=vec3(.015,.085,.09);middle=vec3(.04,.36,.29);pale=vec3(.32,.70,.52);}
// Daylight pigments: shade with hue changes rather than the dark palette's shadows.
vec3 dayA=vec3(.66,.79,1.),dayB=vec3(.86,.69,.98);
if(tone>4.5){dayA=vec3(.80,.72,1.);dayB=vec3(.66,.92,1.);}
else if(tone>3.5){dayA=vec3(1.,.73,.80);dayB=vec3(1.,.85,.65);}
else if(tone>2.5){dayA=vec3(.62,.82,1.);dayB=vec3(.68,.93,.98);}
else if(tone>1.5){dayA=vec3(.62,.87,.81);dayB=vec3(.80,.95,.73);}
// Aspect-correct coordinates keep newer patterns undistorted in tall panels.
vec2 a=gl_FragCoord.xy/max(resolution.y,1.);
if(shape<.5){
vec2 q=vec2(fbm(p+vec2(.0,t*.25)),fbm(p+vec2(4.3,-t*.18)));
vec2 r=vec2(fbm(p+q*2.8+vec2(1.7,t*.22)),fbm(p+q*2.2+vec2(8.3,-t*.17)));
float f=fbm(p+3.6*r+vec2(t*.08,0.));
float wave=p.y*1.8+p.x*.65+r.x*2.8+q.y*1.6+t*.13;
float ribbon=.5+.5*sin(wave*2.4);
float sheen=pow(ribbon,9.);
color=mix(deep,middle,smoothstep(.20,.73,f));
color=mix(color,pale,sheen*.67);

color+=pale*.16*pow(.5+.5*sin(wave*2.4+.4),20.);
if(dark<.5){
 color=mix(vec3(1.),mix(dayA,dayB,smoothstep(.20,.73,f)),.30+.70*sheen);
}
}else if(shape>1.5&&shape<2.5){
 float drift=sin(uv.y*4.+t*.35)*.10;
 float curtain=sx-.46-drift-.16*sin(uv.y*2.6-t*.2);
 float ribbon=exp(-pow(curtain*7.,2.));
 float fold=.65+.35*sin(uv.y*8.+sx*4.+t*.4);
 color=mix(deep*.5,middle,ribbon*.75);
 color+=pale*ribbon*fold*.45;
 if(dark<.5)color=mix(vec3(1.),mix(dayA,dayB,fold),ribbon*(.65+.35*fold));
}else if(shape>2.5&&shape<3.5){
 vec2 sp=a*2.6+vec2(.2,0.);
 vec3 g=bend(sp,t*1.6);
 vec3 normal=normalize(vec3(-g.xy*.32,1.));
 vec3 light=normalize(vec3(-.45,.70,.90));
 float diffuse=max(dot(normal,light),0.);
 float highlight=pow(max(dot(normal,normalize(light+vec3(0,0,1))),0.),48.);
 float satin=pow(diffuse,6.);
 color=mix(deep*.7,middle,smoothstep(.25,.95,diffuse));
 color+=pale*(satin*.42+highlight*1.05);
 if(dark<.5){
  vec3 pigment=mix(dayA,dayB,.5+.5*g.z);
  color=mix(vec3(1.),pigment,.30+.55*(1.-diffuse));
  color=mix(color,vec3(1.),highlight*.85);
 }
}else if(shape>3.5&&shape<4.5){
 vec2 cp=a*6.5-vec2(250.);
 float depth=fbm(a*1.6+vec2(t*.4,-t*.3));
 float c=caustic(cp,time*.16+19.);
 float c2=caustic(cp*1.35+vec2(5.,2.),time*.12+41.);
 float light=clamp(c*1.5+c2*.8,0.,1.6);
 color=mix(deep*.8,middle*.75,smoothstep(.25,.85,depth));
 color+=mix(middle,pale,smoothstep(.2,.9,light))*light*.95;
 if(dark<.5)color=mix(vec3(1.),mix(dayA,dayB,depth),.18+.62*clamp(light,0.,1.));
}else if(shape>4.5){
 vec2 np=a*2.3;
 float n1=fbm(np*1.2+vec2(t*.6,-t*.4));
 float n2=fbm(np*2.0-vec2(t*.3,t*.5)+n1*1.7);
 float cloud=smoothstep(.30,.82,n2);
 float dust=smoothstep(.55,.95,fbm(np*3.1+n2*2.+vec2(-t*.2,t*.1)));
 color=deep*.55+middle*cloud*.95+pale*pow(cloud,3.)*.75-deep*dust*.3;
 // Sparse twinkling stars, one candidate per 14px cell.
 vec2 cell=floor(gl_FragCoord.xy/14.),local=fract(gl_FragCoord.xy/14.);
 float h=hash(cell);
 vec2 at=.2+.6*vec2(hash(cell+7.1),hash(cell+3.3));
 float twinkle=.55+.45*sin(time*(.8+h*1.7)+h*40.);
 float star=step(.86,h)*twinkle*exp(-dot(local-at,local-at)*260.);
 color+=mix(pale,vec3(1.),.6)*star*2.4;
 if(dark<.5)color=mix(vec3(1.),mix(dayA,dayB,cloud),.10+.45*cloud);
}else{
 vec2 sp=vec2(sx*.93,uv.y*1.9);
 float z=surface(sp,t),eps=.012;
 vec3 normal=normalize(vec3(-(surface(sp+vec2(eps,0.),t)-z)/eps,-(surface(sp+vec2(0.,eps),t)-z)/eps,1.));
 vec3 light=normalize(vec3(-.55,.75,1.1));
 float diffuse=.42+.58*max(dot(normal,light),0.);
 float highlight=pow(max(dot(normal,normalize(light+vec3(0,0,1))),0.),24.);
 float band=smoothstep(-.55,.55,z+sp.x*.25-.1);
 vec3 azure=middle,ice=pale,violet=deep;
 color=mix(azure,ice,band);
 color=mix(color,violet,smoothstep(.1,.85,sp.x-z)*.55);
 color=color*diffuse+pale*highlight*.23;
 if(dark<.5){
  float crest=.47+.27*sin(uv.y*3.8+t*.18);
  float field=exp(-pow((sx-crest)/.53,2.))*exp(-pow((uv.y-.34)/.34,2.));
  float fold=exp(-pow((sx-crest-.12)/.16,2.));
  vec3 pigment=mix(dayA,dayB,band*.72);
  color=mix(vec3(1.),pigment,field*(.20+.43*diffuse));
  color-=vec3(.017,.018,.020)*(1.-diffuse)*field;
  color=mix(color,vec3(1.),fold*.50+highlight*.24);

 }
}
float grain=(hash(gl_FragCoord.xy)-.5)*mix(.038,.012,min(shape,1.));
if(dark<.5)grain*=.20;
color=max(vec3(0.),color+grain);
float power=mask*(.45+.55*smoothstep(0.,.12,uv.y));
// Light surfaces preserve white around the pigment; dark surfaces emit light.
if(dark<.5){
 power*=.90;
 // Balance broad cool-color surfaces while retaining the softer green and warm tones.
 if(tone<1.5 || (tone>2.5 && tone<3.5) || tone>4.5)power*=.90;
 else if(tone<2.5)power*=.94;
}else{
 color*=.60;
}
// 50 maps to strength 1 and preserves the original rendering exactly.
// Fade the layer below the midpoint; deepen pigment or emitted light above it.
power*=min(strength,1.);
float boost=max(strength,1.);
if(strength>1.)color=dark<.5 ? clamp(vec3(1.)-(vec3(1.)-color)*boost,0.,1.) : clamp(color*boost,0.,1.);
// Premultiplied alpha stays continuous over native translucent surfaces.
gl_FragColor=vec4(color*power,power);
}`;
