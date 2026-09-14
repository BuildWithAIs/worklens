// Procedural surface shading and domain warping; no textures or physics solver.
export const backgroundShader = `precision mediump float;
uniform vec2 resolution;uniform float time,tone,shape,edge;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+1.),f.x),f.y);}
float fbm(vec2 p){float v=0.;float a=.55;for(int i=0;i<4;i++){v+=a*noise(p);p=mat2(.80,-.60,.60,.80)*p*2.02+3.17;a*=.48;}return v;}
float surface(vec2 p,float t){
 return .46*sin(p.x*2.2+p.y*1.7+t*.31)
       +.32*cos(p.y*2.8-p.x*.7-t*.23)
       +.13*sin(p.x*3.4-p.y*1.3+t*.15);
}
void main(){
vec2 uv=gl_FragCoord.xy/resolution;float y=1.-uv.y;float sx=uv.x;
float mask=smoothstep(.22,.66,y);
if(edge>.5)mask=max(1.-smoothstep(0.,24.,resolution.x-gl_FragCoord.x),1.-smoothstep(0.,28.,gl_FragCoord.y))*.28;
if(mask<.001){gl_FragColor=vec4(0.);return;}
vec2 p=vec2(sx*.6,uv.y*1.9);float t=time*.065;
vec3 color;
vec3 deep=vec3(.035,.035,.12),middle=vec3(.18,.24,.48),pale=vec3(.55,.43,.61);
if(tone>3.5){deep=vec3(.13,.025,.08);middle=vec3(.48,.15,.24);pale=vec3(.83,.46,.29);}
else if(tone>2.5){deep=vec3(.065,.085,.11);middle=vec3(.24,.29,.34);pale=vec3(.56,.63,.68);}
else if(tone>1.5){deep=vec3(.015,.085,.09);middle=vec3(.04,.36,.29);pale=vec3(.32,.70,.52);}
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
}else if(shape>1.5){
 float drift=sin(uv.y*4.+t*.35)*.10;
 float curtain=sx-.46-drift-.16*sin(uv.y*2.6-t*.2);
 float ribbon=exp(-pow(curtain*7.,2.));
 float fold=.65+.35*sin(uv.y*8.+sx*4.+t*.4);
 color=mix(deep*.5,middle,ribbon*.75);
 color+=pale*ribbon*fold*.45;
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
}
float grain=(hash(gl_FragCoord.xy)-.5)*mix(.038,.012,shape);
color=max(vec3(0.),color+grain);
float power=mask*(.45+.55*smoothstep(0.,.12,uv.y));
if(tone>2.5 && tone<3.5)power*=.78;
// Premultiplied alpha stays continuous over native translucent surfaces.
gl_FragColor=vec4(color*power*.60,power);
}`;
