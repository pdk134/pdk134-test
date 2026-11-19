str1 = 'hello world'
position = str1.index(' ') 
str2 = str1[:position + 1] + str1[:len(str1)-position-1:-1]
count_dict = { a:str2.count(a) for a in str2 if a.isalpha()}
print(count_dict)